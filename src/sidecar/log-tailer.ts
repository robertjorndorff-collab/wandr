import { open, stat, watch } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { EventEmitter } from 'node:events';

// Strip ANSI escape codes (CSI, OSC, single-char escapes) for clean Slack messages
const ANSI_REGEX =
  // eslint-disable-next-line no-control-regex
  /[\x1B\x9B](?:\][^\x07\x1B]*(?:\x07|\x1B\\)|[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
export function stripAnsi(text: string): string {
  // Replace escape sequences with a space (they often represent cursor moves
  // that create visual spacing in the TUI). Then collapse runs of spaces.
  return text.replace(ANSI_REGEX, ' ').replace(/ {2,}/g, ' ');
}

// Patterns that look like secrets and should be scrubbed before output reaches Slack.
// Order matters: more specific patterns run first so generic catch-alls don't shadow them.
const SECRET_PATTERNS: RegExp[] = [
  // AWS access key IDs
  /AKIA[0-9A-Z]{16}/g,
  // Slack tokens
  /xox[boaprs]-[A-Za-z0-9-]{10,}/g,
  // Provider-prefixed tokens (OpenAI, GitHub, Anthropic-style, etc.)
  /(?:sk-|pk-|ghp_|gho_|ghu_|ghs_|github_pat_)[A-Za-z0-9_-]{20,}/g,
  // Connection strings (postgres://, redis://, mongodb://, mysql://)
  /(?:postgres|postgresql|mysql|redis|mongodb)(?:\+srv)?:\/\/[^\s'"]+/gi,
  // .env-style assignments for known secret keys
  /(?:DATABASE_URL|REDIS_URL|SECRET_KEY|PRIVATE_KEY|ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET)\s*=\s*\S+/gi,
  // Generic key=value / key: value where the value looks like a secret (16+ chars)
  /(?:api[_-]?key|token|secret|password|passwd|pwd|auth)\s*[:=]\s*['"]?[A-Za-z0-9_\-.]{16,}['"]?/gi,
];

/**
 * Replace anything that looks like a credential with [REDACTED].
 * Runs after noise filtering, before the line is emitted to Slack.
 */
export function redactSecrets(line: string): string {
  let out = line;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]');
  }
  return out;
}

// Box-drawing, block, and common TUI frame chars
// eslint-disable-next-line no-misleading-character-class
export const BOX_DRAWING_REGEX = /[\u2500-\u257F\u2580-\u259F\u2800-\u28FF]/g;

// Claude Code thinking spinner glyphs
const SPINNER_CHARS = new Set(['✱', '✶', '✻', '✸', '✧', '❖', '·', '∗', '✳', '✺']);

/**
 * Returns true if the line is TUI noise that should not be forwarded to Slack.
 */
export function isNoiseLine(raw: string): boolean {
  // Drop box-drawing chars, then trim — frame-only lines collapse to empty
  const stripped = raw.replace(BOX_DRAWING_REGEX, '').trim();
  if (stripped.length === 0) return true;

  // ── Short-line heuristic ──
  // Lines under 5 chars are almost always TUI artifacts (spinner fragments,
  // streaming char chunks, counter digits). Real output is longer.
  if (stripped.length <= 4) return true;

  // ── Pure numbers (counter/progress artifacts) ──
  if (/^\d+$/.test(stripped)) return true;

  // ── Spinner glyphs (with optional digits/words) ──
  if ([...stripped].some((c) => SPINNER_CHARS.has(c))) {
    // Spinner char alone, spinner+digits, spinner+short word
    if (stripped.length <= 12) return true;
    // Spinner + status word like "✱ Thinking…" or "✶ Crafting…"
    if (/^[✱✶✻✸✧❖·∗✳✺]\s*\S+…?$/u.test(stripped)) return true;
  }

  // ── Claude Code TUI chrome ──
  if (/bypass ?permissions ?on/i.test(stripped)) return true;
  if (/^[❯>]\s*$/.test(stripped)) return true;
  if (/for shortcuts/i.test(stripped)) return true;
  if (/shift\+tab/i.test(stripped)) return true;
  if (/esc ?to ?interrupt/i.test(stripped)) return true;
  if (/checking for updates/i.test(stripped)) return true;
  if (/connector.*needs? auth/i.test(stripped)) return true;
  if (/Visual Studio Code disconnected/i.test(stripped)) return true;
  if (/Tip:.*Run Claude/i.test(stripped)) return true;
  if (/Tip:.*\/feedback/i.test(stripped)) return true;
  if (/Tip:.*clau\.de/i.test(stripped)) return true;
  if (/^Tip:/i.test(stripped)) return true;

  // ── Thinking/reasoning noise ──
  // These are handled by throttle in emitCleanLine, NOT killed here.
  // Only kill the truly useless fragments that contain thinking.
  // Lines that are JUST "(thinking)" with no other content → kill (dedup handles the rest)
  if (/^\s*\(?thinking\)?\s*$/i.test(stripped)) return true;
  if (/^\s*\(thought for \d+s\)\s*$/i.test(stripped)) return true;

  // ── Streaming/progress artifacts ──
  if (/[Bb]unning/i.test(stripped)) return true; // corrupted "Running"
  if (/^\s*Running…/i.test(stripped)) return true;
  if (/[↓↑]\s*\d+\s*tokens/i.test(stripped)) return true; // token counters
  if (/Cogitated for/i.test(stripped)) return true; // thinking time
  if (/Tip: Use \/feedback/i.test(stripped)) return true;
  if (/\/remote-control is active/i.test(stripped)) return true;
  if (/medium.*\/effort/i.test(stripped)) return true;
  if (/ClaudeCode\s*v/i.test(stripped)) return true;
  if (/Opus.*context/i.test(stripped)) return true;
  if (/~\/Desktop\//i.test(stripped)) return true; // cwd echo

  // ── Character fragment heuristic ──
  // If the line is mostly non-letter chars or very short words, it's noise
  const letters = stripped.replace(/[^a-zA-Z]/g, '');
  if (letters.length <= 3 && stripped.length <= 8) return true;

  return false;
}

/**
 * Tails a log file and emits new lines as they appear.
 * Starts reading from the end of the file — only new output is captured.
 * Handles the file not existing yet (waits for creation).
 */
export class LogTailer extends EventEmitter {
  private offset = 0;
  private watcher: AsyncIterable<unknown> | null = null;
  private running = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pendingLine = ''; // Buffer for incomplete lines between reads
  private lastEmittedLine = ''; // Dedup: suppress consecutive identical lines
  private lastEmittedCount = 0;
  private lastThinkingEmitMs = 0; // Throttle: only emit thinking status once per 30s

  constructor(
    private readonly logPath: string,
    private readonly pollIntervalMs = 500,
  ) {
    super();
  }

  async start(): Promise<void> {
    this.running = true;

    // Ensure log directory exists
    const dir = dirname(this.logPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Wait for the log file to appear if it doesn't exist yet
    if (!existsSync(this.logPath)) {
      this.emit('waiting', this.logPath);
      await this.waitForFile();
    }

    if (!this.running) return;

    // Seek to end — only tail new content
    const info = await stat(this.logPath);
    this.offset = info.size;
    this.emit('attached', this.logPath, this.offset);

    // Poll for new content — more reliable than fs.watch across platforms
    this.pollTimer = setInterval(() => {
      void this.readNew();
    }, this.pollIntervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async waitForFile(): Promise<void> {
    return new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (!this.running) {
          clearInterval(check);
          resolve();
          return;
        }
        if (existsSync(this.logPath)) {
          clearInterval(check);
          resolve();
        }
      }, this.pollIntervalMs);
    });
  }

  private async readNew(): Promise<void> {
    try {
      const info = await stat(this.logPath);
      if (info.size <= this.offset) {
        // No new data — flush pending line if it's been sitting there
        if (this.pendingLine.trim().length > 0) {
          this.emitCleanLine(this.pendingLine);
          this.pendingLine = '';
        }
        return;
      }

      const fh = await open(this.logPath, 'r');
      try {
        const bytesToRead = info.size - this.offset;
        const buf = Buffer.alloc(bytesToRead);
        await fh.read(buf, 0, bytesToRead, this.offset);
        this.offset = info.size;

        const text = stripAnsi(buf.toString('utf-8'));
        const lines = text.split('\n');

        // Prepend any buffered partial line to the first chunk
        if (lines.length > 0) {
          lines[0] = this.pendingLine + lines[0];
          this.pendingLine = '';
        }

        // Last element is either empty (text ended with \n) or a partial line
        const lastLine = lines.pop() ?? '';
        if (lastLine.length > 0) {
          this.pendingLine = lastLine; // Save for next read
        }

        // Emit all complete lines
        for (const rawLine of lines) {
          this.emitCleanLine(rawLine);
        }
      } finally {
        await fh.close();
      }
    } catch (err) {
      // File may have been truncated or rotated
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.offset = 0;
        return;
      }
      this.emit('error', err);
    }
  }

  private emitCleanLine(rawLine: string): void {
    if (isNoiseLine(rawLine)) return;
    // Strip residual box-drawing chars from kept lines
    const cleaned = rawLine.replace(BOX_DRAWING_REGEX, '').trimEnd();
    if (cleaned.trim().length === 0) return;
    // Dedup: suppress consecutive identical lines
    if (cleaned === this.lastEmittedLine) {
      this.lastEmittedCount++;
      return;
    }

    // Throttle thinking/spinner status: allow once per 30s, suppress the rest
    const isThinking = /\(thinking\)/i.test(cleaned)
      || /\(thought for/i.test(cleaned)
      || /^[\u2731\u2736\u273b\u2738\u2727\u2756\u00b7\u2217\u2733\u273a]?\s*[A-Z][a-z]+\u2026/u.test(cleaned.replace(BOX_DRAWING_REGEX, '').trim());
    if (isThinking) {
      const now = Date.now();
      if (now - this.lastThinkingEmitMs < 30_000) return; // suppress
      this.lastThinkingEmitMs = now; // allow this one through
    }

    this.lastEmittedLine = cleaned;
    this.lastEmittedCount = 0;
    this.emit('line', redactSecrets(cleaned));
  }
}
