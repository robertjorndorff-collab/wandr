# TICKET: Basic Test Suite
## Priority: P0 — MUST before public release
## Agent: wandr

---

## Problem

Zero tests. vitest is configured but no test files exist. Open source projects with no tests get roasted on Reddit/HN.

## What to Test

Focus on the units that matter most — the ones with state and logic:

### 1. `log-tailer.ts` — isNoiseLine()
- Lines that SHOULD be filtered (spinners, thinking, ANSI chrome, short fragments)
- Lines that should NOT be filtered (real output, commit messages, file paths)
- Edge cases: lines with mixed content (real text + spinner glyph)

### 2. `log-tailer.ts` — stripAnsi()
- ANSI escape sequences replaced with spaces
- Multiple spaces collapsed
- Clean text passes through unchanged

### 3. `checkpoint.ts` — State Machine
- idle → working transition on activity
- working → complete transition after idle timeout
- working → stalled transition after stall timeout
- Task received resets state
- Queue dispatch on task complete

### 4. Secret Redaction (after wandr-secret-redaction.md is done)
- API keys redacted
- Connection strings redacted
- Normal text NOT redacted
- Commit hashes NOT redacted

## File Structure

```
src/
  sidecar/
    __tests__/
      log-tailer.test.ts
      checkpoint.test.ts
      redaction.test.ts (after redaction ticket)
```

## Run

```bash
npm test
# or
npx vitest run
```

## Acceptance Criteria

- [ ] `npm test` runs and passes
- [ ] isNoiseLine has 15+ test cases covering real patterns from production logs
- [ ] stripAnsi has 5+ test cases
- [ ] Checkpoint state machine has 8+ test cases covering all transitions
- [ ] No flaky tests (no timers, no network, no Redis in unit tests)

## DO NOTs

- Do NOT add integration tests that require Redis or Slack — unit tests only
- Do NOT mock everything — test the actual functions with real input strings
- Do NOT add test dependencies beyond vitest (already installed)
