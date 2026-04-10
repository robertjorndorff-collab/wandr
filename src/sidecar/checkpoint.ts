import { EventEmitter } from 'node:events';
import { spawnSync, execSync } from 'node:child_process';
import type { SlackTransport } from './slack-transport.js';

export type CheckpointState = 'idle' | 'working' | 'stalled';

const IDLE_TIMEOUT_MS = 30 * 1000;
const STALLED_TIMEOUT_MS = 5 * 60 * 1000;
const UNRESPONSIVE_TIMEOUT_MS = 10 * 60 * 1000;
const WORKING_TICK_MS = 60 * 1000;
const HEARTBEAT_MS = 15 * 60 * 1000;

/**
 * Monitors LogTailer activity and posts structured status messages
 * directly to Slack (bypassing the batched MessageQueue).
 *
 * Emits 'task-complete' when working → idle, so the task queue can drain.
 */
export class Checkpoint extends EventEmitter {
  private state: CheckpointState = 'idle';
  private lastActivityAt = 0;
  private taskDispatchedAt = 0;
  private lastMeaningfulLine = '';
  private currentPrompt: string | null = null;
  private restarted = false;

  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private workingTickTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly agentId: string,
    private readonly transport: SlackTransport,
    private readonly logFile: string,
  ) {
    super();
  }

  start(): void {
    this.tickTimer = setInterval(() => this.tick(), 5000);
    this.heartbeatTimer = setInterval(() => {
      void this.transport.postCheckpoint(`💚 [${this.agentId}] HEARTBEAT — ${this.state}`);
    }, HEARTBEAT_MS);
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.workingTickTimer) clearInterval(this.workingTickTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.tickTimer = null;
    this.workingTickTimer = null;
    this.heartbeatTimer = null;
  }

  onActivity(line: string): void {
    this.lastActivityAt = Date.now();
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      this.lastMeaningfulLine = trimmed.slice(0, 80);
    }
    if (this.state === 'idle' && this.taskDispatchedAt > 0) {
      this.transitionToWorking();
    } else if (this.state === 'stalled') {
      // Recovered from stall
      this.transitionToWorking();
    }
  }

  onTaskDispatched(prompt: string): void {
    this.taskDispatchedAt = Date.now();
    this.lastActivityAt = Date.now();
    this.currentPrompt = prompt;
    this.restarted = false;
    void this.transport.postCheckpoint(
      `🟢 [${this.agentId}] TASK RECEIVED: ${prompt.slice(0, 100)}`,
    );
    this.transitionToWorking();
  }

  getCurrentPrompt(): string | null {
    return this.currentPrompt;
  }

  getState(): CheckpointState {
    return this.state;
  }

  private transitionToWorking(): void {
    if (this.state === 'working') return;
    this.state = 'working';
    if (!this.workingTickTimer) {
      this.workingTickTimer = setInterval(() => {
        if (this.state === 'working') {
          void this.transport.postCheckpoint(
            `⏳ [${this.agentId}] WORKING — ${this.lastMeaningfulLine || '(no output yet)'}`,
          );
        }
      }, WORKING_TICK_MS);
    }
  }

  private transitionToIdle(): void {
    if (this.state === 'idle') return;
    this.state = 'idle';
    this.taskDispatchedAt = 0;
    this.currentPrompt = null;
    if (this.workingTickTimer) {
      clearInterval(this.workingTickTimer);
      this.workingTickTimer = null;
    }
    void this.transport.postCheckpoint(
      `✅ [${this.agentId}] TASK COMPLETE — idle, awaiting next command`,
    );
    this.emit('task-complete');
  }

  private tick(): void {
    if (this.state !== 'working' && this.state !== 'stalled') return;
    if (this.taskDispatchedAt === 0) return;

    const sinceActivity = Date.now() - this.lastActivityAt;

    if (this.state === 'working') {
      if (sinceActivity >= STALLED_TIMEOUT_MS) {
        this.state = 'stalled';
        void this.transport.postCheckpoint(
          `🟡 [${this.agentId}] STALLED — no output for 5 min`,
        );
        return;
      }
      if (sinceActivity >= IDLE_TIMEOUT_MS) {
        this.transitionToIdle();
        return;
      }
    }

    if (this.state === 'stalled') {
      if (sinceActivity >= UNRESPONSIVE_TIMEOUT_MS) {
        if (!this.restarted) {
          this.restarted = true;
          void this.restart();
        } else {
          void this.transport.postCheckpoint(
            `🔴 [${this.agentId}] UNRESPONSIVE — consider restart`,
          );
        }
      }
    }
  }

  /**
   * Watchdog: kill tmux session, respawn claude, re-dispatch the pending prompt.
   */
  private async restart(): Promise<void> {
    const pending = this.currentPrompt;
    await this.transport.postCheckpoint(
      `🔴 [${this.agentId}] RESTARTING — context likely exhausted`,
    );

    spawnSync('tmux', ['kill-session', '-t', this.agentId]);
    await new Promise((r) => setTimeout(r, 2000));

    let claudeBin = 'claude';
    try {
      claudeBin = execSync('which claude').toString().trim() || 'claude';
    } catch {
      // fall back
    }

    spawnSync('tmux', [
      'new-session', '-d', '-s', this.agentId,
      '-x', '220', '-y', '50',
      claudeBin,
    ]);
    spawnSync('tmux', [
      'pipe-pane', '-t', this.agentId, '-o',
      `tee -a ${this.logFile} > /dev/null`,
    ]);

    await this.transport.postCheckpoint(
      `🟢 [${this.agentId}] RESTARTED — replaying last task`,
    );

    if (pending) {
      // Give claude a moment to boot before sending input
      await new Promise((r) => setTimeout(r, 3000));
      this.emit('restart-redispatch', pending);
      this.taskDispatchedAt = Date.now();
      this.lastActivityAt = Date.now();
      this.currentPrompt = pending;
      this.state = 'working';
    }
  }
}
