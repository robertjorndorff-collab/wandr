# WANDR — Operations Runbook

## Starting Up (Full Cold Start)

```bash
# 1. Start Redis (doesn't survive reboots)
redis-server --daemonize yes

# 2. Start Wandr orchestrator
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

## Common Issues

- **"No projects config found"** — `config/projects.json` is missing. Check it exists in `~/Desktop/Wandr/config/`.
- **Hanging on startup** — Redis isn't running. `redis-cli ping` to check, `redis-server --daemonize yes` to fix.
- **Port 9400 conflict** — Stale sidecar. Preflight auto-kills it, but if needed: `pkill -f "tsx src/index.ts"` or `lsof -ti tcp:9400 | xargs kill`.
- **Agent in wrong directory** — Fixed in `up.ts` (April 12, 2026). `up` now reads `projects.json` to resolve CWD. If it recurs, check that the project prefix is in `projects.json`.
- **Redis doesn't survive reboots** — Always start Redis first after a reboot.

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
