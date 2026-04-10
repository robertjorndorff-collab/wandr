import { readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { EventEmitter } from 'node:events';

/**
 * Watches a command file for incoming prompts.
 * When a Slack command arrives (`!agent-id <prompt>`), Wandr writes
 * the prompt to `~/.wandr/input/{agent-id}.cmd`. This bridge detects
 * new content, emits it, and clears the file.
 *
 * Protocol:
 * - Writer (Wandr sidecar) writes prompt text to the .cmd file
 * - Reader (this bridge) detects content, reads it, truncates the file
 * - One command at a time — write is atomic (rename pattern if needed later)
 */
export class InputBridge extends EventEmitter {
  private running = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastSize = 0;

  constructor(
    private readonly cmdPath: string,
    private readonly pollIntervalMs = 300,
  ) {
    super();
  }

  start(): void {
    this.running = true;

    // Ensure directory and file exist
    const dir = dirname(this.cmdPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    if (!existsSync(this.cmdPath)) {
      writeFileSync(this.cmdPath, '', 'utf-8');
    }

    this.pollTimer = setInterval(() => {
      void this.check();
    }, this.pollIntervalMs);

    this.emit('ready', this.cmdPath);
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Write a command to the file (called by Wandr when Slack message arrives) */
  async sendCommand(prompt: string): Promise<void> {
    await writeFile(this.cmdPath, prompt, 'utf-8');
  }

  private async check(): Promise<void> {
    try {
      const info = await stat(this.cmdPath);
      if (info.size === 0) {
        this.lastSize = 0;
        return;
      }
      // Only process if size changed (new write)
      if (info.size === this.lastSize) return;
      this.lastSize = info.size;

      const content = (await readFile(this.cmdPath, 'utf-8')).trim();
      if (!content) return;

      // Clear the file immediately to avoid re-processing
      await writeFile(this.cmdPath, '', 'utf-8');
      this.lastSize = 0;

      this.emit('command', content);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.emit('error', err);
      }
    }
  }
}
