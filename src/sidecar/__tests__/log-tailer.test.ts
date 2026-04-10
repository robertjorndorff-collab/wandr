import { describe, it, expect } from 'vitest';
import { isNoiseLine, stripAnsi, redactSecrets } from '../log-tailer.js';

describe('stripAnsi', () => {
  it('removes CSI color codes', () => {
    expect(stripAnsi('\x1b[31mhello\x1b[0m')).toBe(' hello ');
  });

  it('replaces escape sequences with a space', () => {
    expect(stripAnsi('a\x1b[2Jb')).toBe('a b');
  });

  it('collapses runs of multiple spaces', () => {
    expect(stripAnsi('foo\x1b[1m\x1b[2m\x1b[3mbar')).toBe('foo bar');
  });

  it('passes clean text through unchanged', () => {
    expect(stripAnsi('plain text line')).toBe('plain text line');
  });

  it('handles empty input', () => {
    expect(stripAnsi('')).toBe('');
  });

  it('strips OSC sequences', () => {
    expect(stripAnsi('\x1b]0;title\x07after')).toBe(' after');
  });
});

describe('isNoiseLine — should filter', () => {
  const noise: Array<[string, string]> = [
    ['empty string', ''],
    ['whitespace only', '   '],
    ['box drawing only', '────────────'],
    ['short fragment', 'abc'],
    ['pure number', '12345'],
    ['spinner glyph alone', '✱'],
    ['spinner + Thinking…', '✱ Thinking…'],
    ['bypass permissions', 'bypass permissions on'],
    ['shortcuts hint', '? for shortcuts'],
    ['shift+tab hint', 'shift+tab to cycle'],
    ['esc to interrupt', 'esc to interrupt'],
    ['checking for updates', 'checking for updates'],
    ['just (thinking)', '(thinking)'],
    ['thought for', '(thought for 12s)'],
    ['corrupted Bunning', 'Bunning some task...'],
    ['token counter', '↓ 1234 tokens'],
    ['Tip line', 'Tip: Run Claude with --help'],
    ['Cogitated', 'Cogitated for 5s'],
  ];
  for (const [name, line] of noise) {
    it(`drops: ${name}`, () => {
      expect(isNoiseLine(line)).toBe(true);
    });
  }
});

describe('isNoiseLine — should keep', () => {
  const keep: Array<[string, string]> = [
    ['real sentence', 'Refactoring the message queue to support priority lanes'],
    ['file path', 'src/sidecar/log-tailer.ts:42'],
    ['commit message', '[STATUS] Committed: 80f5b2c feat(slack): add purge'],
    ['code snippet', 'function foo(bar: string): number { return 1; }'],
    ['error message', 'Error: ECONNREFUSED 127.0.0.1:6379'],
  ];
  for (const [name, line] of keep) {
    it(`keeps: ${name}`, () => {
      expect(isNoiseLine(line)).toBe(false);
    });
  }
});

describe('redactSecrets', () => {
  it('redacts AWS access key IDs', () => {
    const out = redactSecrets('key=AKIAIOSFODNN7EXAMPLE end');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('redacts Slack bot tokens', () => {
    const out = redactSecrets('token: xoxb-1234567890-abcdefghijklmnop');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('xoxb-1234567890');
  });

  it('redacts GitHub PATs', () => {
    const out = redactSecrets('using ghp_abcdefghijklmnopqrstuvwxyz0123456789 to auth');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('ghp_abcdef');
  });

  it('redacts OpenAI-style sk- keys', () => {
    const out = redactSecrets('OPENAI_KEY=sk-abcdefghijklmnopqrstuvwxyz0123');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts postgres connection strings', () => {
    const out = redactSecrets('connecting to postgres://user:pass@host:5432/db now');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('user:pass');
  });

  it('redacts redis connection strings', () => {
    const out = redactSecrets('REDIS=redis://:secretpw@127.0.0.1:6379/0');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts DATABASE_URL assignments', () => {
    const out = redactSecrets('DATABASE_URL=postgres://x:y@h/db');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts api_key style assignments', () => {
    const out = redactSecrets('api_key="abcdef0123456789abcdef"');
    expect(out).toContain('[REDACTED]');
  });

  it('does NOT redact normal text', () => {
    const text = 'Refactored the message queue to support priority lanes';
    expect(redactSecrets(text)).toBe(text);
  });

  it('does NOT redact short commit hashes', () => {
    const text = '[STATUS] Committed: 80f5b2c feat(slack): purge command';
    expect(redactSecrets(text)).toBe(text);
  });

  it('does NOT redact file paths', () => {
    const text = 'src/sidecar/log-tailer.ts:213';
    expect(redactSecrets(text)).toBe(text);
  });
});
