import 'dotenv/config';
import Redis from 'ioredis';
import { WebClient } from '@slack/web-api';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, access, constants } from 'node:fs/promises';

const MANAGER_PORT = 9400;

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

const REQUIRED_ENV = [
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  'SLACK_SIGNING_SECRET',
  'SLACK_CHANNEL_ID',
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

  // 2. Redis ping
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await redis.connect();
    await redis.ping();
    ok(`Redis reachable (${redisUrl})`);
  } catch (err) {
    fail(`Redis unreachable at ${redisUrl}: ${(err as Error).message}`);
    result.errors.push('redis');
    result.ok = false;
  } finally {
    redis.disconnect();
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
