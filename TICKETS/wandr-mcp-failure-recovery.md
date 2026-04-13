# TICKET: MCP Server Failure Recovery on Agent Startup

## Agent: Clode1
## Priority: P1
## Project: Wandr + Last/JobScout

## Problem
When LJS Clode starts, MCP servers fail silently and the agent just sits there broken:

1. "1 MCP server needs auth" — likely Vercel (OAuth)
2. "1 MCP server failed" — unknown, possibly ai-bridge or RapidAPI
3. "1 claude.ai connector unavailable" — Claude.ai connector

No retry, no recovery, no alert. Agent runs in degraded state without operator awareness.

## Investigation Required
1. Which MCP servers are failing? Check `.mcp.json` in jobflow-ai and identify which ones map to these errors.
2. Can Claude Code retry MCP connections? Check if `/mcp` command can reconnect.
3. Can Wandr's sidecar detect "MCP server failed" in the log stream and alert via Slack?

## Fix
Two layers:

### Layer 1: Immediate (Wandr sidecar)
- Detect "MCP server failed" / "MCP server needs auth" in log-tailer output
- Post a ⚠️ alert to #wandr-ops with the specific server name
- Optionally: auto-send `/mcp` to attempt reconnect

### Layer 2: Session init (Claude Code)
- After Session Start Sequence, Clode should run `/mcp` and verify all required MCPs are connected
- If ai-bridge is down, that blocks constitution/guidance — Clode should report this as a blocker, not silently continue

## Acceptance Criteria
- [ ] MCP failures produce a visible alert in #wandr-ops
- [ ] Agent attempts recovery (retry or `/mcp`)
- [ ] If recovery fails, status is reported as degraded — not idle

## Notes
- This is cross-project: sidecar detection is Wandr, MCP config is per-project
- The ai-bridge MCP is critical for AXIS PRAXIS init — if it's down, the session is broken
