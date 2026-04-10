import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type Redis from 'ioredis';
import type { SidecarConfig, MessageType } from './types.js';
import { MessageQueue } from './message-queue.js';
import { SlackTransport } from './slack-transport.js';
import { ApprovalGate } from './approval-gate.js';
import { StateStore } from './state-store.js';

// Strip ANSI escape codes for clean Slack messages
const ANSI_REGEX = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, '');
}

interface SidecarOptions {
  flushIntervalMs: number;
  flushSizeLimit: number;
  recentMessageLimit: number;
}

/**
 * Core sidecar: runs Claude in print mode (`-p`), captures output,
 * pipes to Redis-backed queue, flushes to Slack in batches.
 * Agent-agnostic — same class works for any agent ID.
 *
 * Uses `claude -p "<prompt>"` per task invocation. The sidecar controls
 * the conversation loop — send prompt, capture response, log to Slack.
 * This avoids TTY requirements entirely (Claude's interactive REPL
 * needs a TTY, but print mode runs headless).
 */
export class AgentSidecar extends EventEmitter {
  private activeProcess: ChildProcess | null = null;
  private running = false;
  readonly queue: MessageQueue;
  readonly approvals: ApprovalGate;
  readonly state: StateStore;

  constructor(
    private readonly sidecarConfig: SidecarConfig,
    private readonly redis: Redis,
    private readonly transport: SlackTransport,
    private readonly options: SidecarOptions,
  ) {
    super();

    this.state = new StateStore(redis, sidecarConfig.agentId);
    this.approvals = new ApprovalGate(redis, sidecarConfig.agentId, transport);

    this.queue = new MessageQueue(
      redis,
      sidecarConfig.agentId,
      {
        flushIntervalMs: options.flushIntervalMs,
        flushSizeLimit: options.flushSizeLimit,
        recentMessageLimit: options.recentMessageLimit,
      },
      (messages) => transport.sendBatch(messages),
    );

    this.approvals.on('requested', () => {
      void this.state.update({ state: 'waiting_approval' });
    });
    this.approvals.on('resolved', () => {
      void this.state.update({ state: 'running' });
    });
  }

  get agentId(): string {
    return this.sidecarConfig.agentId;
  }

  async start(): Promise<void> {
    this.running = true;
    await this.state.register();
    this.queue.start();
    await this.enqueue('system', `Sidecar online for agent \`${this.agentId}\`. Awaiting tasks.`);
    this.emit('ready');
  }

  /**
   * Run a single prompt through Claude in print mode.
   * Spawns `claude -p "<prompt>"`, streams output to the queue,
   * and resolves with the full response when the process exits.
   */
  async runTask(prompt: string): Promise<string> {
    if (!this.running) throw new Error('Sidecar not started');

    const { command, args: baseArgs, env, cwd } = this.sidecarConfig;

    await this.state.update({ state: 'running' });
    await this.enqueue('system', `Task received: ${prompt.slice(0, 120)}${prompt.length > 120 ? '...' : ''}`);

    // Spawn claude in print mode: claude [baseArgs] -p "<prompt>"
    const spawnArgs = [...baseArgs, '-p', prompt];
    this.activeProcess = spawn(command, spawnArgs, {
      env: { ...process.env, ...env },
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Close stdin immediately — print mode doesn't need it
    this.activeProcess.stdin?.end();

    const chunks: string[] = [];

    return new Promise<string>((resolve, reject) => {
      this.activeProcess!.stdout?.on('data', (chunk: Buffer) => {
        const text = stripAnsi(chunk.toString());
        chunks.push(text);
        const trimmed = text.trim();
        if (trimmed) {
          void this.enqueue('output', trimmed);
        }
      });

      this.activeProcess!.stderr?.on('data', (chunk: Buffer) => {
        const text = stripAnsi(chunk.toString()).trim();
        if (text) {
          void this.enqueue('error', text);
        }
      });

      this.activeProcess!.on('exit', (code) => {
        this.activeProcess = null;
        const fullResponse = chunks.join('').trim();

        if (code === 0) {
          void this.enqueue('system', `Task complete (${fullResponse.length} chars)`);
          void this.state.update({ state: 'idle' });
          resolve(fullResponse);
        } else {
          const err = `Claude exited with code ${code}`;
          void this.enqueue('error', err);
          void this.state.update({ state: 'error' });
          reject(new Error(err));
        }
      });

      this.activeProcess!.on('error', (err) => {
        this.activeProcess = null;
        void this.enqueue('error', `Spawn error: ${err.message}`);
        void this.state.update({ state: 'error' });
        reject(err);
      });
    });
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.activeProcess && this.activeProcess.exitCode === null) {
      await this.enqueue('system', 'Stopping active task...');
      this.activeProcess.kill('SIGTERM');

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          this.activeProcess?.kill('SIGKILL');
          resolve();
        }, 5000);

        this.activeProcess?.on('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }

    await this.enqueue('system', 'Sidecar shutting down.');
    this.queue.stop();
    await this.state.deregister();
    this.emit('stopped');
  }

  async requestApproval(prompt: string): Promise<{ approved: boolean; respondedBy?: string }> {
    await this.enqueue('approval_gate', prompt);
    return this.approvals.request(prompt);
  }

  private async enqueue(type: MessageType, content: string): Promise<void> {
    await this.queue.enqueue({
      timestamp: new Date().toISOString(),
      agentId: this.sidecarConfig.agentId,
      type,
      content,
    });
    await this.state.incrementMessages();
  }
}
