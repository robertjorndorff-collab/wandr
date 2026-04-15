import 'dotenv/config';
import Redis from 'ioredis';
import { WebClient } from '@slack/web-api';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, access, constants } from 'node:fs/promises';

const MANAGER_PORT = Number(process.env.MANAGER_API_PORT) || 9400;

async function pingRedis(url: string): Promise<boolean> {
  const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 2000 });
  try {
    await redis.connect();
    await redis.ping();
    return true;
  } catch {
    return false;
  } finally {
    redis.disconnect();
  }
}

function tryStartRedis(): boolean {
  try {
    const r = execSync('redis-server --daemonize yes', { stdio: ['ignore', 'pipe', 'pipe'] });
    void r;
    return true;
  } catch {
    return false;
  }
}

function freePort(port: number): void {
  try {
    const out = execSync(`lsof -ti tcp:${port}`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    if (!out) return;
    const pids = out.split('\n').filter(Boolean);
    for (const pid of pids) {
      try {
        process.kill(Number(pid), 'SIGTERM');
      } catch { /* ignore */ }
    }
    console.log(`[wandr] \u26A0 Killed stale process(es) on port ${port}: ${pids.join(', ')}`);
  } catch {
    /* nothing listening — fine */
  }
}

export interface PreflightResult {
  ok: boolean;
  anthropicKeyInEnv: boolean;
  errors: string[];
  warnings: string[];
}

// SLACK_APP_TOKEN and SLACK_SIGNING_SECRET are only required for the orchestrator
// sidecar (the one that opens Socket Mode). Plain agent sidecars use REST API only.
const REQUIRED_ENV = [
  'SLACK_BOT_TOKEN',
  'SLACK_CHANNEL_ID',
];

const ORCHESTRATOR_ENV = [
  'SLACK_APP_TOKEN',
  'SLACK_SIGNING_SECRET',
];

function ok(msg: string): void {
  console.log(`[wandr] \u2713 ${msg}`);
}
function warn(msg: string): void {
  console.log(`[wandr] \u26A0 ${msg}`);
}
function fail(msg: string): void {
  console.error(`[wandr] \u2717 ${msg}`);
}

export async function runPreflight(agentId: string): Promise<PreflightResult> {
  const result: PreflightResult = {
    ok: true,
    anthropicKeyInEnv: false,
    errors: [],
    warnings: [],
  };

  // 0. Free manager port if a stale process is holding it
  freePort(MANAGER_PORT);

  // 1. .env required vars
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    fail(`.env missing required vars: ${missing.join(', ')}`);
    result.errors.push(`missing env: ${missing.join(',')}`);
    result.ok = false;
  } else {
    ok(`.env loaded (channel ${process.env.SLACK_CHANNEL_ID})`);
  }

  // 1b. Orchestrator-specific env vars
  if (process.env.WANDR_ORCHESTRATOR === '1') {
    const missingOrch = ORCHESTRATOR_ENV.filter((k) => !process.env[k]);
    if (missingOrch.length > 0) {
      fail(`Orchestrator mode requires: ${missingOrch.join(', ')}`);
      result.errors.push(`missing orchestrator env: ${missingOrch.join(',')}`);
      result.ok = false;
    } else {
      ok(`Orchestrator env vars present`);
    }
  }

  // 2. Redis ping — auto-start if missing (watchdog requirement)
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const redisOk = await pingRedis(redisUrl);
  if (redisOk) {
    ok(`Redis reachable (${redisUrl})`);
  } else {
    warn(`Redis unreachable at ${redisUrl} — attempting auto-start via \`redis-server --daemonize yes\``);
    const started = tryStartRedis();
    if (!started) {
      fail(`Could not auto-start Redis. Install redis (\`brew install redis\`) and retry.`);
      result.errors.push('redis');
      result.ok = false;
    } else {
      // Give it a moment to bind the socket
      for (let i = 0; i < 10; i++) {
        if (await pingRedis(redisUrl)) break;
        await new Promise((r) => setTimeout(r, 300));
      }
      if (await pingRedis(redisUrl)) {
        ok(`Redis auto-started (${redisUrl})`);
      } else {
        fail(`Redis started but is still not reachable at ${redisUrl}`);
        result.errors.push('redis');
        result.ok = false;
      }
    }
  }

  // 3. Slack auth.test
  if (process.env.SLACK_BOT_TOKEN) {
    try {
      const client = new WebClient(process.env.SLACK_BOT_TOKEN);
      const auth = await client.auth.test();
      ok(`Slack auth ok (bot: ${auth.user ?? 'unknown'})`);
    } catch (err) {
      fail(`Slack auth.test failed: ${(err as Error).message}`);
      result.errors.push('slack-auth');
      result.ok = false;
    }
  }

  // 4. ~/.wandr dirs writable
  const wandrHome = join(homedir(), '.wandr');
  const logDir = join(wandrHome, 'logs');
  const inputDir = join(wandrHome, 'input');
  try {
    await mkdir(logDir, { recursive: true });
    await mkdir(inputDir, { recursive: true });
    await access(logDir, constants.W_OK);
    await access(inputDir, constants.W_OK);
    ok(`~/.wandr/{logs,input} writable`);
  } catch (err) {
    fail(`~/.wandr dirs not writable: ${(err as Error).message}`);
    result.errors.push('dirs');
    result.ok = false;
  }

  // 5. ANTHROPIC_API_KEY detection
  if (process.env.ANTHROPIC_API_KEY) {
    warn('ANTHROPIC_API_KEY found in shell env — stripping from claude child to avoid auth prompt');
    warn('Consider removing it from ~/.zshrc to silence this warning');
    result.anthropicKeyInEnv = true;
    result.warnings.push('anthropic-key-stripped');
  }

  void agentId;
  return result;
}
