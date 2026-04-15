# TICKET: WANDR-INIT-001 — Skip Trust Prompt on Agent Launch

## Priority: P0

## Problem
When Wandr launches Claude Code via `up.ts`, agents in directories without a `.git` folder get stuck on the interactive "Do you trust this folder?" prompt. This blocks headless operation and requires manual intervention — defeating the purpose of automated agent orchestration.

## Root Cause
Claude Code shows a trust prompt for any directory that isn't a git repository. The `--dangerously-skip-permissions` flag should bypass this but has a known bug (anthropics/claude-code#28506) where it doesn't always work in non-git directories.

## Fix (belt and suspenders)

### 1. Pass `--dangerously-skip-permissions` in `up.ts`
When spawning the Claude Code process inside tmux, add the flag to the launch command. This is the intended way to run Claude Code headlessly for autonomous agents.

Current (assumed):
```
claude
```

Should be:
```
claude --dangerously-skip-permissions
```

### 2. Git init fallback in nuke.sh (DONE)
`nuke.sh` already updated to run `git init` on any project directory lacking `.git`. This ensures the trust prompt never fires even if the flag bug persists.

## Acceptance Criteria
- [ ] `up.ts` passes `--dangerously-skip-permissions` when launching Claude Code
- [ ] No agent ever gets stuck on a trust prompt during headless launch
- [ ] Existing manual `tmux attach` workflow still works (flag doesn't break interactive use)

## Security Note
This is acceptable because Wandr agents operate on Rob's local machine in trusted project directories. The flag is designed for exactly this use case — headless autonomous agents. All project dirs are owned by Rob.

## Related
- WANDR-HEALTH-001 (auto-recovery)
- WANDR-UX-001 (Slack output noise)
- nuke.sh (already updated with git init step)
