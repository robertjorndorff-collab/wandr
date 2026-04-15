# WANDR — Operations Runbook

## Starting Up (Full Cold Start)

```bash
# 1. Start Redis (doesn't survive reboots)
redis-server --daemonize yes

# 2. Start Wandr orchestrator (auto-enables orchestrator mode for 'wandr' prefix)
cd ~/Desktop/Wandr
node dist/index.js up wandr

# 3. Start any agents you need
node dist/index.js up ljs
node dist/index.js up trover
node dist/index.js up village
# etc — any key from config/projects.json
```

## Interacting With Agents

Two ways, same session:

- **Slack (`#wandr-ops`):** `!ljs <prompt>` — works from anywhere (phone, walk, couch)
- **Terminal:** `tmux attach -t ljs` — hands-on Claude Code session

Detach from tmux without killing: `Ctrl-B` then `d`
Switch agents: `tmux attach -t trover`

## Shutting Down

```bash
cd ~/Desktop/Wandr
node dist/index.js down ljs
node dist/index.js down trover
node dist/index.js down wandr
```

Kill everything in reverse order (agents first, orchestrator last).

## Project Mappings

Defined in `config/projects.json` (fallback: `~/.wandr/projects.json`).

| Prefix | Directory |
|--------|-----------|
| ljs | ~/Desktop/jobflow-ai |
| wandr | ~/Desktop/Wandr |
| trover | ~/Desktop/dataorchestrator |
| village | ~/Desktop/THE VILLAGE THAT REMEMBERS |
| consultcommando | ~/Desktop/CONSULT AND COMMAND CENTER/ConsultCommando |
| rjorndorff | ~/Desktop/rjorndorff-consulting |
| axispraxis | ~/Desktop/axispraxis |
| spectrio | ~/Desktop/SPECTRIO_RECOVERED |
| troversite | ~/Desktop/trover-site |
| troverdemo | ~/Desktop/trover-demo |
| ideation | ~/Desktop/PRODUCT IDEATION |

## Health Monitoring & Auto-Recovery

The orchestrator (`wandr up wandr`) continuously watches every registered agent and
restarts any that go dark. The operator does not babysit liveness.

- **Heartbeat** — each sidecar pulses `wandr:{id}:heartbeat` every 30s with a 120s TTL.
- **Dead detection** — if a heartbeat is older than 90s (3 missed beats) the agent is marked DEAD.
- **Auto-restart** — orchestrator runs `wandr down <id> && wandr up <id>`. Max 3 attempts.
- **Single notification** — one `🛑` message in `#wandr-ops` after the last retry fails; zero spam during retries.
- **Command replay** — if a routed `!<agent> <prompt>` hits a DEAD agent, it's queued and replayed automatically once recovery succeeds.
- **Redis watchdog** — preflight runs `redis-server --daemonize yes` when Redis is missing at startup, and the orchestrator alerts once in Slack if Redis drops mid-session (then again when it returns).
- **Startup gate** — `wandr up <id>` verifies the Manager API `/health` endpoint, the sidecar PID, and the tmux pane process before reporting success. A failed gate tears down the session and exits non-zero.

## Channel Hygiene

The orchestrator auto-purges `#wandr-ops` so the operator can read it at a glance.

- Default threshold: **50 messages**. Override with `WANDR_AUTO_PURGE_THRESHOLD=<n>`; set `0` to disable.
- Purge runs every 2 minutes; only bot messages are deleted.
- Manual purge still works: `!purge`, `!purge 50`, `!purge all`.
- Output streams drop thinking/reasoning prose, shell install noise, stack-trace frames, and MCP failures after the first occurrence per session.

## Common Issues

- **"No projects config found"** — `config/projects.json` is missing. Check it exists in `~/Desktop/Wandr/config/`.
- **Hanging on startup** — Redis isn't running. Preflight auto-starts it via `redis-server --daemonize yes`; `redis-cli ping` to verify manually.
- **Port 9400 conflict** — Stale sidecar. Preflight auto-kills it, but if needed: `pkill -f "tsx src/index.ts"` or `lsof -ti tcp:9400 | xargs kill`.
- **Agent in wrong directory** — Fixed in `up.ts` (April 12, 2026). `up` now reads `projects.json` to resolve CWD. If it recurs, check that the project prefix is in `projects.json`.
- **Redis doesn't survive reboots** — Preflight auto-starts it on the next `wandr up`, so you rarely have to do it by hand.
- **Agent flagged "unresponsive" in Slack** — heartbeat missed. Auto-recovery kicks in; no action needed unless you see the 🛑 manual-intervention message.

## Key Commands Reference

| Action | Command |
|--------|---------|
| Start agent | `node dist/index.js up <prefix>` |
| Stop agent | `node dist/index.js down <prefix>` |
| Attach terminal | `tmux attach -t <prefix>` |
| Detach terminal | `Ctrl-B` then `d` |
| Slack dispatch | `!<prefix> <prompt>` |
| Check Redis | `redis-cli ping` |
| Start Redis | `redis-server --daemonize yes` |
