# WANDR — Remote Command & Control for AI Agents

## What This Is
Wandr is the orchestration layer for all Clode agents across all projects. It provides Slack-based observability (log tailing → #wandr-ops), command dispatch (operator sends prompts via Slack), and agent lifecycle management.

## Tech Stack
- TypeScript / Node.js 20+
- Slack Bolt (Socket Mode) for real-time messaging
- Redis for message queuing and state
- Claude CLI for agent process management

## Architecture
- `src/index.ts` — main entry, supports `--attach` (log tail) and spawn modes
- `src/sidecar/` — agent-sidecar (spawn), log-tailer (attach), command-dispatch, message-queue, slack-transport, state-store, approval-gate
- `src/api/` — manager API (GET /status, /approvals, /digest, /health)
- `scripts/wandr-start.sh` — bootstrap script for starting agents with log tailing
- `config/lexicon.json` — operator command keywords
- `TICKETS/` — all work items live here

## AXIS PRAXIS Rules
1. **Read your ticket fully before writing any code.**
2. **No fire-and-forget.** Every change must be committed and pushed.
3. **No phantom endpoints.** Don't create APIs or routes that nothing calls.
4. **State sync before deploy.** Pull before push. Always.
5. **Scope discipline.** Stay in your project directory. Do not write outside the project root.
6. **Non-destructive only.** No `rm -rf`, no `DROP TABLE`, no `git push --force`. See `.claude/settings.local.json` for the full deny list.
7. **Commit early, commit often.** Small atomic commits with descriptive messages.
8. **If stuck for more than 2 attempts on the same error, stop and document the blocker in the ticket.**

## Agent Naming Convention
All agents use project-scoped IDs: `{project}-{role}{number}`
- `myapp-dev1`, `myapp-dev2` — multiple agents on the same project
- `backend-agent1` — agent working in the `backend` project
- `docs-writer1` — agent working in the `docs` project

Map prefixes to project directories in `scripts/wandr-launch.sh`.

## Reporting
You cannot post to Slack directly. Your output is captured via the sidecar/log-tailer and forwarded to #wandr-ops automatically. **Write clear, parseable status lines to stdout** so the log tailer picks them up:
- Start of task: `[STATUS] Starting: <description>`
- Completion: `[STATUS] Complete: <description>`
- Error: `[STATUS] Error: <description>`
- Commit: `[STATUS] Committed: <hash> <message>`

## Relationship to AXIS PRAXIS

Wandr implements the operational layer of [AXIS PRAXIS](https://axispraxis.ai) — a governance framework for AI-assisted development. AXIS PRAXIS defines rules like "no fire-and-forget," "state sync before deploy," and "scope discipline." Wandr enforces these at runtime through checkpoint protocols, approval gates, and observable agent behavior.

If AXIS PRAXIS is the constitution, Wandr is the executive branch.

## Key Files
- `.env` — Slack tokens, Redis URL, channel ID (DO NOT read or modify)
- `TICKETS/` — all work items
