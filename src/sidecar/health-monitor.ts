import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type Redis from 'ioredis';
import { StateStore } from './state-store.js';
import type { SlackTransport } from './slack-transport.js';

const POLL_INTERVAL_MS = 30_000;
const HEARTBEAT_GRACE_MS = 90_000; // 3x the 30s heartbeat cadence
const MAX_RECOVERY_ATTEMPTS = 3;
const RECOVERY_BACKOFF_MS = 5_000;

type AgentHealth = 'healthy' | 'recovering' | 'dead';

interface AgentTracker {
  health: AgentHealth;
  attempts: number;
  failureNotified: boolean;
  pendingCommands: string[];
}

/**
 * Watches every registered agent's heartbeat and auto-recovers dead ones.
 *
 * Contract:
 *   • Sidecars call StateStore.heartbeat() every 30s. TTL is 120s.
 *   • If heartbeat key is missing / stale beyond grace, mark DEAD.
 *   • Auto-recovery: run `node dist/index.js down <id>` then `up <id>`.
 *   • Max 3 retries. ONE Slack message on final failure — no spam.
 *   • On successful recovery, replay any commands queued by routing guard.
 */
export class HealthMonitor extends EventEmitter {
  private trackers = new Map<string, AgentTracker>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly redis: Redis,
    private readonly transport: SlackTransport,
    private readonly selfAgentId: string,
    private readonly wandrRoot: string,
  ) {
    super();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.pollTimer = setInterval(() => {
      void this.tick().catch((err) => {
        console.error(`[wandr:health] tick error: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, POLL_INTERVAL_MS);
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Queue a command to be replayed after this agent recovers. */
  queueForReplay(agentId: string, prompt: string): void {
    const t = this.ensureTracker(agentId);
    t.pendingCommands.push(prompt);
  }

  /** Force-check a specific agent and trigger recovery if dead. Returns health. */
  async checkAgent(agentId: string): Promise<AgentHealth> {
    if (agentId === this.selfAgentId) return 'healthy';
    const tracker = this.ensureTracker(agentId);
    if (tracker.health === 'recovering') return 'recovering';

    const alive = await this.isHeartbeatFresh(agentId);
    if (alive) {
      if (tracker.health === 'dead') {
        tracker.health = 'healthy';
        tracker.attempts = 0;
        tracker.failureNotified = false;
      }
      return 'healthy';
    }

    tracker.health = 'dead';
    return 'dead';
  }

  private ensureTracker(agentId: string): AgentTracker {
    let t = this.trackers.get(agentId);
    if (!t) {
      t = { health: 'healthy', attempts: 0, failureNotified: false, pendingCommands: [] };
      this.trackers.set(agentId, t);
    }
    return t;
  }

  private async isHeartbeatFresh(agentId: string): Promise<boolean> {
    const ts = await StateStore.getHeartbeat(this.redis, agentId);
    if (ts === null) return false;
    return Date.now() - ts <= HEARTBEAT_GRACE_MS;
  }

  private async tick(): Promise<void> {
    const agentIds = await this.redis.smembers('wandr:agents');
    for (const agentId of agentIds) {
      if (agentId === this.selfAgentId) continue;
      const tracker = this.ensureTracker(agentId);
      if (tracker.health === 'recovering') continue;

      const alive = await this.isHeartbeatFresh(agentId);
      if (alive) {
        if (tracker.health === 'dead') {
          tracker.health = 'healthy';
          tracker.attempts = 0;
          tracker.failureNotified = false;
        }
        continue;
      }

      if (tracker.attempts >= MAX_RECOVERY_ATTEMPTS) {
        if (!tracker.failureNotified) {
          tracker.failureNotified = true;
          await this.transport.postCheckpoint(
            `🛑 \`${agentId}\` is down and auto-recovery failed after ${MAX_RECOVERY_ATTEMPTS} attempts. Manual intervention required.`,
          );
        }
        continue;
      }

      await this.recover(agentId, tracker);
    }
  }

  private async recover(agentId: string, tracker: AgentTracker): Promise<void> {
    tracker.health = 'recovering';
    tracker.attempts += 1;
    console.log(`[wandr:health] ${agentId} DEAD — recovery attempt ${tracker.attempts}/${MAX_RECOVERY_ATTEMPTS}`);
    try {
      await this.runCli(['down', agentId]);
    } catch (err) {
      console.error(`[wandr:health] down ${agentId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise((r) => setTimeout(r, RECOVERY_BACKOFF_MS));
    try {
      await this.runCli(['up', agentId]);
    } catch (err) {
      console.error(`[wandr:health] up ${agentId} failed: ${err instanceof Error ? err.message : String(err)}`);
      tracker.health = 'dead';
      return;
    }

    // Give the new sidecar a moment to emit its first heartbeat.
    await new Promise((r) => setTimeout(r, 15_000));
    const alive = await this.isHeartbeatFresh(agentId);
    if (!alive) {
      tracker.health = 'dead';
      return;
    }

    tracker.health = 'healthy';
    tracker.attempts = 0;
    tracker.failureNotified = false;
    const replayCount = tracker.pendingCommands.length;
    if (replayCount > 0) {
      await this.transport.postCheckpoint(
        `♻️ \`${agentId}\` recovered — replaying ${replayCount} queued command${replayCount === 1 ? '' : 's'}.`,
      );
      const commands = [...tracker.pendingCommands];
      tracker.pendingCommands.length = 0;
      for (const cmd of commands) {
        this.emit('replay', agentId, cmd);
      }
    } else {
      await this.transport.postCheckpoint(`♻️ \`${agentId}\` recovered.`);
    }
  }

  private runCli(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const entry = process.env.WANDR_DEV ? ['tsx', 'src/index.ts'] : ['node', 'dist/index.js'];
      const [cmd, ...cmdArgs] = entry;
      const proc = spawn(cmd, [...cmdArgs, ...args], {
        cwd: this.wandrRoot,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
      proc.on('error', reject);
      proc.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`exit ${code}: ${stderr.slice(0, 200)}`));
      });
      // Hard timeout so a stuck spawn doesn't lock the monitor.
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
        reject(new Error('timeout after 60s'));
      }, 60_000).unref();
    });
  }
}
