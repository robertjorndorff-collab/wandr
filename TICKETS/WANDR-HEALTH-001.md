# TICKET: WANDR-HEALTH-001 — Agent Auto-Recovery & Health Monitoring

## Priority: P0

## Problem
When the sidecar or an agent session dies, commands route into a black hole with zero feedback. The human operator has no way to know agents are down until they manually check. There is no auto-recovery, no health check, no heartbeat, no watchdog. The entire system is manual start / manual diagnose / manual restart.

This defeats the purpose of Wandr as an orchestration layer. If the operator has to babysit liveness, it's not orchestration — it's a fancy tmux wrapper.

## Requirements

### 1. Agent Health Check (Heartbeat)
- Each agent pings a heartbeat at a configurable interval (suggest every 30s)
- Orchestrator tracks last heartbeat per agent
- If heartbeat missed for N intervals (suggest 3 = 90s), agent is marked DEAD

### 2. Auto-Recovery
- When an agent is marked DEAD, orchestrator automatically attempts restart: `node dist/index.js down <prefix> && node dist/index.js up <prefix>`
- Max retry attempts: 3
- If all retries fail, post ONE message to #wandr-ops: "[agent] is down and auto-recovery failed. Manual intervention required."
- Do NOT spam the channel with retry attempts

### 3. Command Routing Feedback
- When a command is routed to an agent that is DEAD or unresponsive, immediately notify the operator: "[agent] is unresponsive. Attempting auto-recovery."
- Do NOT silently route commands to dead agents
- If recovery succeeds, replay the queued command automatically

### 4. Startup Health Gate
- On `node dist/index.js up <prefix>`, verify the agent session is actually alive before reporting success
- Check: tmux session exists, sidecar port responding, Claude Code process running
- If any check fails, report which component failed

### 5. Redis Watchdog
- Redis doesn't survive reboots and is a single point of failure
- On orchestrator start, check Redis. If down, start it automatically
- If Redis dies mid-session, detect and restart (or at minimum alert once)

## Acceptance Criteria
- [ ] Agents have a heartbeat mechanism
- [ ] Dead agents are auto-restarted (max 3 retries)
- [ ] Commands to dead agents trigger recovery, not silent routing
- [ ] Operator gets exactly ONE notification per failure event
- [ ] Redis is auto-started if missing
- [ ] OPERATIONS.md updated with health monitoring docs

## Context
This was exposed when two dispatched commands (CLODE-VXT-AUDIT + WANDR-UX-001) routed successfully but neither agent picked up. Zero feedback to operator. Commands went into a black hole.
