import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPreflight } from './preflight.js';

function resolveProjectDir(agentId: string): string {
  const prefix = agentId.split('-')[0] || agentId;
  const home = homedir();

  // Check ~/.wandr/projects.json first, then config/projects.json relative to Wandr root
  const candidates = [
    join(home, '.wandr', 'projects.json'),
    join(dirname(dirname(__dirname)), 'config', 'projects.json'),
  ];

  for (const configPath of candidates) {
    if (existsSync(configPath)) {
      const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
      const dir = cfg[prefix];
      if (dir) {
        return dir.replace(/^~/, home);
      }
    }
  }

  // Fallback: current working directory
  return process.cwd();
}

const READY_TIMEOUT_MS = 10_000;

function resolveClaudeBin(): string {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const which = spawnSync('which', ['claude'], { encoding: 'utf-8' });
  if (which.status === 0) {
    const path = which.stdout.trim();
    if (path) return path;
  }
  return 'claude';
}
const CLAUDE_BIN = resolveClaudeBin();

function tmux(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync('tmux', args, { encoding: 'utf-8' });
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function tmuxHasSession(name: string): boolean {
  return tmux(['has-session', '-t', name]).ok;
}

export async function runUp(agentId: string, claudeArgs: string[]): Promise<void> {
  // Auto-enable orchestrator for the 'wandr' agent (the command router)
  const orchestratorIdx = claudeArgs.indexOf('--orchestrator');
  let isOrchestrator = orchestratorIdx !== -1;
  if (isOrchestrator) {
    claudeArgs.splice(orchestratorIdx, 1);
  }
  if (agentId === 'wandr' && !isOrchestrator) {
    isOrchestrator = true;
  }

  // Headless agents must never block on Claude Code's trust prompt.
  // Project directories without .git trigger it; passing this flag skips it.
  if (!claudeArgs.includes('--dangerously-skip-permissions')) {
    claudeArgs.unshift('--dangerously-skip-permissions');
  }

  console.log(`[wandr] Bringing up agent: ${agentId}${isOrchestrator ? ' (orchestrator)' : ''}`);

  const pre = await runPreflight(agentId);
  if (!pre.ok) {
    console.error(`[wandr] Preflight failed: ${pre.errors.join(', ')}`);
    process.exit(1);
  }

  const wandrHome = join(homedir(), '.wandr');
  const logsDir = join(wandrHome, 'logs');
  const inputDir = join(wandrHome, 'input');
  if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
  if (!existsSync(inputDir)) mkdirSync(inputDir, { recursive: true });

  const logFile = join(logsDir, `${agentId}.log`);
  const sidecarLog = join(logsDir, `${agentId}.sidecar.log`);
  const sessionMarker = `\n=== session ${new Date().toISOString()} ===\n`;
  await appendFile(logFile, sessionMarker);
  await appendFile(sidecarLog, sessionMarker);

  // ── 1. Refuse if a tmux session already exists ───────────────────
  if (tmuxHasSession(agentId)) {
    console.error(`[wandr] tmux session "${agentId}" already exists.`);
    console.error(`[wandr]   Attach:  tmux attach -t ${agentId}`);
    console.error(`[wandr]   Stop:    wandr down ${agentId}  (or: tmux kill-session -t ${agentId})`);
    process.exit(1);
  }

  // ── 1b. Assign unique Manager API port per agent ─────────────────
  // Each sidecar runs a Manager API. Preflight freePort() kills whatever is
  // on that port. Without unique ports, starting agent B kills agent A's sidecar.
  const portOffset = [...agentId].reduce((sum, c, i) => sum + c.charCodeAt(0) * (i + 1), 0) % 100;
  const agentPort = 9400 + portOffset;
  process.env.MANAGER_API_PORT = String(agentPort);
  console.log(`[wandr] \u2713 Manager API port: ${agentPort}`);

  // ── 2. Start sidecar detached, stdio → sidecar log ────────────────
  if (isOrchestrator) {
    process.env.WANDR_ORCHESTRATOR = '1';
    console.log(`[wandr] ✓ Orchestrator mode — this sidecar routes all !commands`);
  }

  const sidecarEntry = process.env.WANDR_DEV
    ? { cmd: 'tsx', args: ['src/index.ts', '--attach', agentId] }
    : { cmd: 'node', args: ['dist/index.js', '--attach', agentId] };

  const sidecarOut = openSync(sidecarLog, 'a');
  const sidecar = spawn(sidecarEntry.cmd, sidecarEntry.args, {
    stdio: ['ignore', sidecarOut, sidecarOut],
    env: process.env,
    detached: true,
  });
  sidecar.unref();

  const pidFile = join(wandrHome, 'run', `${agentId}.sidecar.pid`);
  if (!existsSync(join(wandrHome, 'run'))) mkdirSync(join(wandrHome, 'run'), { recursive: true });
  writeFileSync(pidFile, String(sidecar.pid), 'utf-8');

  // ── 3. Wait for sidecar READY by tailing its log ──────────────────
  await waitForReady(sidecarLog, READY_TIMEOUT_MS).catch((err) => {
    console.error(`[wandr] \u2717 ${err.message}`);
    console.error(`[wandr]   See ${sidecarLog} for sidecar output`);
    try { process.kill(sidecar.pid!, 'SIGTERM'); } catch { /* ignore */ }
    process.exit(1);
  });
  console.log(`[wandr] \u2713 Sidecar attached (pid ${sidecar.pid}) \u2192 ${logFile}`);

  // ── 4. Spawn Claude inside a detached tmux session ────────────────
  // Strip ANTHROPIC_API_KEY so Claude uses stored credentials.
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) childEnv[k] = v;
  }
  if (pre.anthropicKeyInEnv) delete childEnv.ANTHROPIC_API_KEY;

  // Set CLODE_AGENT_ID so Claude Code session knows its identity.
  // Used by AI Bridge MCP for per-agent guidance files (bridge-guidance-clodeN.json).
  // If agentId contains 'clode' (e.g., ljs-clode2), extract that part.
  // Otherwise default to 'clode1' (primary agent for this project).
  const clodeMatch = agentId.match(/clode\d+/);
  const clodeAgentId = clodeMatch ? clodeMatch[0] : 'clode1';
  childEnv.CLODE_AGENT_ID = clodeAgentId;
  console.log(`[wandr] ✓ CLODE_AGENT_ID=${clodeAgentId}`);

  // tmux's command form: `tmux new-session -d -s NAME [args...] -- CMD ARGS`
  // We pass each arg separately so quoting is not an issue.
  const projectDir = resolveProjectDir(agentId);
  if (!existsSync(projectDir)) {
    console.error(`[wandr] ✗ Project directory not found: ${projectDir}`);
    try { process.kill(sidecar.pid!, 'SIGTERM'); } catch { /* ignore */ }
    process.exit(1);
  }
  console.log(`[wandr] ✓ Project directory: ${projectDir}`);

  const newSession = spawnSync(
    'tmux',
    [
      'new-session', '-d',
      '-s', agentId,
      '-x', '220', '-y', '50',
      'env', `CLODE_AGENT_ID=${clodeAgentId}`, CLAUDE_BIN, ...claudeArgs,
    ],
    { env: childEnv, cwd: projectDir, encoding: 'utf-8' },
  );
  if (newSession.status !== 0) {
    console.error(`[wandr] \u2717 tmux new-session failed: ${newSession.stderr}`);
    try { process.kill(sidecar.pid!, 'SIGTERM'); } catch { /* ignore */ }
    process.exit(1);
  }

  // ── 5. Pipe pane output to the agent log file ─────────────────────
  // Use `tee -a` so we append rather than truncate. pipe-pane runs the
  // command under /bin/sh, so shell-quoting matters here.
  const pipeCmd = `tee -a ${shellQuote(logFile)} > /dev/null`;
  const pipe = tmux(['pipe-pane', '-t', agentId, '-o', pipeCmd]);
  if (!pipe.ok) {
    console.error(`[wandr] \u26A0 tmux pipe-pane failed: ${pipe.stderr.trim()}`);
    console.error(`[wandr]   Sidecar log tail will be empty.`);
  }

  // ── 6. Startup health gate ────────────────────────────────────────
  // Confirm that (a) the sidecar's Manager API is responding and (b) a
  // Claude-like process is actually alive inside the tmux pane. If either
  // fails, tear down and exit non-zero so the caller sees a real failure.
  const healthErrors = await runStartupHealthGate(agentId, agentPort, sidecar.pid ?? -1);
  if (healthErrors.length > 0) {
    for (const e of healthErrors) console.error(`[wandr] \u2717 Health gate: ${e}`);
    console.error(`[wandr] \u2717 Startup failed — see ${sidecarLog}`);
    try { tmux(['kill-session', '-t', agentId]); } catch { /* ignore */ }
    try { process.kill(sidecar.pid!, 'SIGTERM'); } catch { /* ignore */ }
    process.exit(1);
  }
  console.log(`[wandr] \u2713 Health gate: sidecar API + tmux pane process confirmed alive`);

  console.log('');
  console.log(`[wandr] \u25B6 Agent "${agentId}" is up.`);
  console.log(`[wandr]   Attach:        tmux attach -t ${agentId}`);
  console.log(`[wandr]   Detach:        Ctrl-B then d`);
  console.log(`[wandr]   Stop agent:    tmux kill-session -t ${agentId}`);
  console.log(`[wandr]   Stop sidecar:  kill ${sidecar.pid}`);
  console.log(`[wandr]   Slack input:   !${agentId} <prompt>`);
  console.log('');
}

export async function runDown(agentId: string): Promise<void> {
  console.log(`[wandr] Bringing down agent: ${agentId}`);
  const wandrHome = join(homedir(), '.wandr');
  const pidFile = join(wandrHome, 'run', `${agentId}.sidecar.pid`);

  // 1. Kill tmux session if present
  if (tmuxHasSession(agentId)) {
    const r = tmux(['kill-session', '-t', agentId]);
    if (r.ok) console.log(`[wandr] \u2713 tmux session "${agentId}" killed`);
    else console.error(`[wandr] \u26A0 kill-session failed: ${r.stderr.trim()}`);
  } else {
    console.log(`[wandr]   no tmux session "${agentId}"`);
  }

  // 2. Kill sidecar via pidfile
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, 'utf-8').trim());
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, 'SIGTERM');
        console.log(`[wandr] \u2713 sidecar pid ${pid} signaled SIGTERM`);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ESRCH') console.log(`[wandr]   sidecar pid ${pid} already gone`);
        else console.error(`[wandr] \u26A0 kill ${pid}: ${(err as Error).message}`);
      }
    }
    try { unlinkSync(pidFile); } catch { /* ignore */ }
  } else {
    console.log(`[wandr]   no sidecar pidfile at ${pidFile}`);
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function runStartupHealthGate(agentId: string, port: number, sidecarPid: number): Promise<string[]> {
  const errors: string[] = [];

  // Check 1: tmux session exists
  if (!tmuxHasSession(agentId)) {
    errors.push(`tmux session "${agentId}" missing`);
  }

  // Check 2: Manager API /health responds
  const apiOk = await pingManagerHealth(port, 5000);
  if (!apiOk) errors.push(`Manager API at 127.0.0.1:${port}/health did not respond`);

  // Check 3: Sidecar process still alive
  if (sidecarPid > 0) {
    try {
      process.kill(sidecarPid, 0);
    } catch {
      errors.push(`sidecar pid ${sidecarPid} is not running`);
    }
  }

  // Check 4: tmux pane has a child process (Claude Code actually spawned)
  if (tmuxHasSession(agentId)) {
    const panes = spawnSync('tmux', ['list-panes', '-t', agentId, '-F', '#{pane_pid}'], { encoding: 'utf-8' });
    const panePid = Number((panes.stdout ?? '').trim().split('\n')[0]);
    if (!Number.isFinite(panePid) || panePid <= 0) {
      errors.push('tmux pane has no PID');
    } else {
      // pgrep -P returns child PIDs. A freshly spawned claude should be a child of the shell/env wrapper.
      const children = spawnSync('pgrep', ['-P', String(panePid)], { encoding: 'utf-8' });
      const hasChild = (children.stdout ?? '').trim().length > 0 || children.status === 0;
      // pgrep returns 1 when no match — treat that as failure. Some envs have `claude` as the pane PID directly; that's fine.
      if (!hasChild) {
        // Fallback: if the pane PID's command itself looks like claude, accept it.
        const cmd = spawnSync('ps', ['-o', 'comm=', '-p', String(panePid)], { encoding: 'utf-8' });
        const comm = (cmd.stdout ?? '').trim().toLowerCase();
        if (!comm.includes('claude') && !comm.includes('node') && !comm.includes('env')) {
          errors.push(`tmux pane pid ${panePid} has no Claude-like process (comm=${comm || 'unknown'})`);
        }
      }
    }
  }

  return errors;
}

async function pingManagerHealth(port: number, timeoutMs: number): Promise<boolean> {
  const http = await import('node:http');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/health', timeout: 1000 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function waitForReady(logPath: string, timeoutMs: number): Promise<void> {
  const { watch, promises: fsp } = await import('node:fs');
  const start = Date.now();
  let offset = 0;
  try { offset = (await fsp.stat(logPath)).size; } catch { /* ignore */ }
  // We wrote a session marker before this, so start from end and re-read tail.
  offset = Math.max(0, offset - 4096);

  return new Promise<void>((resolve, reject) => {
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      try { watcher.close(); } catch { /* ignore */ }
      clearInterval(poller);
      if (err) reject(err); else resolve();
    };

    const check = async () => {
      try {
        const stat = await fsp.stat(logPath);
        if (stat.size <= offset) return;
        const fh = await fsp.open(logPath, 'r');
        const buf = Buffer.alloc(stat.size - offset);
        await fh.read(buf, 0, buf.length, offset);
        await fh.close();
        offset = stat.size;
        if (buf.toString('utf-8').includes('[wandr:attach] READY')) finish();
      } catch { /* ignore */ }
    };

    const watcher = watch(logPath, () => void check());
    const poller = setInterval(() => {
      void check();
      if (Date.now() - start > timeoutMs) {
        finish(new Error(`sidecar did not become READY within ${timeoutMs}ms`));
      }
    }, 250);
    void check();
  });
}
