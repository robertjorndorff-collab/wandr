# TICKET: Sidecar Auto-Restart / Watchdog

## Agent: Wandr Clode
## Priority: P0
## Project: Wandr

## Problem
The sidecar process dies silently while the tmux/Claude session stays alive. This means:
- Slack dispatch stops working (no 🚀, no ⚙️)
- No heartbeats
- No log streaming
- Agent is alive but completely unreachable via Slack
- Operator has no idea until they manually check

This defeats the entire purpose of Wandr.

## Fix
The `up.ts` supervisor needs to monitor the sidecar child process and auto-restart it if it dies.

Options:
1. **Process monitor in up.ts:** After spawning the sidecar, watch for exit. If it dies, respawn automatically. Log the restart to sidecar log.
2. **Separate watchdog loop:** A lightweight health-check that pings the sidecar every 60s and restarts if unresponsive.
3. **systemd/launchd style:** Use `respawn` semantics — if sidecar exits non-zero, restart with backoff.

Option 1 is simplest. The sidecar is already a detached child of `up.ts` — add an `exit` handler that respawns it.

## Also
- On restart, post a ⚠️ to #wandr-ops: `[ljs] Sidecar restarted (crash recovery)`
- Cap restarts at 5 within 10 minutes to prevent infinite loops
- Log each crash + restart to `~/.wandr/logs/<prefix>.sidecar.log`

## Acceptance Criteria
- [ ] Sidecar auto-restarts if it crashes
- [ ] Slack alert on sidecar restart
- [ ] Restart cap (no infinite loops)
- [ ] Crash logged
- [ ] Agent remains fully operational through sidecar restart

## Notes
- This is the #1 reliability issue with Wandr right now
- Until this ships, every sidecar crash requires manual `down` + `up`
