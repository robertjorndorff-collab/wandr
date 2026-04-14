# TICKET: Reduce Slack Log Noise — Suppress Repeated Status Lines

## Agent: Wandr Clode
## Priority: P2
## Project: Wandr

## Problem
When agents are working, #wandr-ops gets spammed with repeated identical status lines like "Building personalized job digest..." appearing 20+ times. The dedup filter catches consecutive identical lines but not near-identical ones (spinner char changes between them).

## Fix
In `src/sidecar/log-tailer.ts`, enhance the dedup logic:
1. Strip spinner chars before comparing for dedup (so "✱ Building..." and "✶ Building..." are treated as identical)
2. Increase suppression window — if same base message repeated 3+ times within 10s, suppress until content changes
3. After suppression, emit one summary: "[ljs] (repeated 15x) Building personalized job digest..."

## Acceptance Criteria
- [ ] Repeated status lines suppressed to max 2-3 per burst
- [ ] Meaningful state changes still come through
- [ ] Build passes
