# WANDR — User Manual

## One Command

```bash
bash ~/Desktop/Wandr/scripts/wandr
```

That's it. Kills everything running, starts Redis, brings up Wandr + LJS. Run it from any terminal, any time, after reboot, after crash, after power loss. Always works.

---

## Adding More Agents

After the base system is up, add agents one at a time:

```bash
cd ~/Desktop/Wandr && node dist/index.js up <prefix>
```

Examples:
```bash
node dist/index.js up trover
node dist/index.js up consultcommando
node dist/index.js up village
```

Each agent gets its own port — they don't interfere with each other.

---

## Talking to Agents

### Via Slack (`#wandr-ops`)
Clai dispatches. You can also type directly in Slack.

```
!ljs <prompt>
!wandr <prompt>
!trover <prompt>
!consultcommando <prompt>
```

### Via Terminal (hands-on)
```bash
tmux attach -t ljs
```

Detach without killing: `Ctrl-B` then `d`

Switch agents: `tmux attach -t trover`

Both methods hit the same Claude Code session.

---

## Stopping Agents

Single agent:
```bash
cd ~/Desktop/Wandr && node dist/index.js down <prefix>
```

Everything:
```bash
cd ~/Desktop/Wandr
node dist/index.js down ljs
node dist/index.js down wandr
```

---

## Multiple Clodes on Same Project

```bash
node dist/index.js up ljs            # CLODE_AGENT_ID=clode1
node dist/index.js up ljs-clode2     # CLODE_AGENT_ID=clode2
node dist/index.js up ljs-clode3     # CLODE_AGENT_ID=clode3
```

Dispatch: `!ljs <prompt>`, `!ljs-clode2 <prompt>`, `!ljs-clode3 <prompt>`

---

## Project Mappings

Edit `~/Desktop/Wandr/config/projects.json` to add or change projects.

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

---

## Slack Status Icons

| Icon | Meaning |
|------|---------|
| 💚 HEARTBEAT | Alive, idle |
| 🟢 TASK RECEIVED | Picked up command |
| ⏳ WORKING | In progress |
| ✅ TASK COMPLETE | Done, awaiting next |
| 📋 QUEUED | Busy, your task is in line |
| ⚠️ MCP FAILURE | MCP server down (handle from tmux) |
| 👋 CEO CHECK-IN | No commands for 4 hours |

---

## Slack Commands

```
!ping              # any live agent responds
!purge             # delete last 100 bot messages
!purge all         # delete all bot messages
!lexicon list      # show keywords
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Everything broken | `bash ~/Desktop/Wandr/scripts/wandr` |
| Single agent down | `cd ~/Desktop/Wandr && node dist/index.js down <prefix> && node dist/index.js up <prefix>` |
| MCP needs auth | `tmux attach -t <prefix>`, handle it, `Ctrl-B d` to detach |
| Redis not running | Script handles it — just run `bash ~/Desktop/Wandr/scripts/wandr` |
| After reboot | `bash ~/Desktop/Wandr/scripts/wandr` |
| After power loss | `bash ~/Desktop/Wandr/scripts/wandr` |

---

## Key File Locations

| What | Where |
|------|-------|
| Startup script | `~/Desktop/Wandr/scripts/wandr` |
| Project mappings | `~/Desktop/Wandr/config/projects.json` |
| Agent logs | `~/.wandr/logs/<prefix>.log` |
| Sidecar logs | `~/.wandr/logs/<prefix>.sidecar.log` |
| Lexicon | `~/Desktop/Wandr/config/lexicon.json` |
| This manual | `~/Desktop/Wandr/USER-MANUAL.md` |
