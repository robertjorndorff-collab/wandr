# TICKET: Secret Redaction in Slack Output
## Priority: P0 — MUST before public release
## Agent: wandr

---

## Problem

Agent output goes straight to Slack. If Claude Code prints an API key, password, database URL, or secret during debugging, it's now in Slack channel history. No redaction layer exists.

## Solution

Add a `redactSecrets()` function that runs on every line BEFORE posting to Slack. Apply it in `emitCleanLine()` in log-tailer.ts, after noise filtering but before emit.

## Patterns to Redact

Replace matches with `[REDACTED]`:

```
# API keys / tokens
/(?:api[_-]?key|token|secret|password|passwd|pwd|auth)\s*[:=]\s*['"]?[A-Za-z0-9_\-\.]{16,}['"]?/gi

# AWS keys
/AKIA[0-9A-Z]{16}/g

# Slack tokens
/xox[boaprs]-[A-Za-z0-9\-]{10,}/g

# Generic long hex/base64 strings that look like secrets (32+ chars)
/(?:sk-|pk-|ghp_|gho_|github_pat_)[A-Za-z0-9_\-]{20,}/g

# Connection strings
/(?:postgres|mysql|redis|mongodb):\/\/[^\s'"]+/gi

# .env style KEY=VALUE where value looks secret
/(?:DATABASE_URL|REDIS_URL|SECRET_KEY|PRIVATE_KEY|ACCESS_TOKEN)\s*=\s*\S+/gi
```

## Files to Modify

| File | Change |
|------|--------|
| `src/sidecar/log-tailer.ts` | Add `redactSecrets()`, call in `emitCleanLine()` |

## Acceptance Criteria

- [ ] Lines containing API keys are redacted before posting to Slack
- [ ] Lines containing connection strings are redacted
- [ ] Lines containing Slack tokens are redacted
- [ ] Normal output (code, file paths, commit hashes) is NOT redacted
- [ ] Redaction uses `[REDACTED]` replacement, not deletion (so you can see something was there)

## DO NOTs

- Do NOT redact short strings that happen to match (commit hashes are fine)
- Do NOT add new dependencies
- Do NOT modify the noise filter logic — this runs AFTER noise filtering
