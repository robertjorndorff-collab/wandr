# TICKET: WANDR-UX-001 — Clean Up Agent Output Streams

## Priority: P0

## Problem
The #wandr-ops Slack channel is unusable for the human operator. The signal-to-noise ratio is terrible. Specific issues:

### 1. Thinking/Reasoning Noise
Agent output includes verbose thinking blocks, chain-of-thought reasoning, and internal monologue that the human doesn't need to see. The operator needs RESULTS, not the agent's thought process. Strip all thinking/reasoning output from Slack messages. Only surface: task acknowledgment, key actions taken, final result/confirmation, and errors.

### 2. Shell Gibberish
Raw shell output (stdout, stderr, escape codes, progress bars, npm install logs, etc.) is dumped directly into Slack. This is unreadable. Suppress all raw shell output. Only surface: the command that was run (brief), success/failure status, and any actual error message if it failed.

### 3. Auto-Purge
There is no automatic cleanup. The channel fills up with garbage and the human has to manually `!purge`. Implement auto-purge at N messages (suggest 50-100 threshold). When message count exceeds N, automatically purge the oldest messages. The human should never have to babysit channel hygiene.

### 4. MCP Connection Noise
When MCP servers fail to load, the error is repeated on EVERY message — sometimes 50+ times in a session. Log the MCP connection failure ONCE at session start. Suppress all subsequent repeats. If the MCP recovers, log that once too.

## Acceptance Criteria
- [ ] No thinking/reasoning blocks in Slack output
- [ ] No raw shell output — only structured status messages
- [ ] Auto-purge at configurable message threshold (default 50)
- [ ] MCP connection errors logged once, not repeated
- [ ] Operator can read #wandr-ops at a glance and understand what happened without scrolling through garbage

## Context
This is blocking Rob from using Wandr as an effective orchestration tool. The whole point is to dispatch and check back — not to babysit a noisy channel.
