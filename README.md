# Wandr

[![CI](https://github.com/robertjorndorff-collab/wandr/actions/workflows/ci.yml/badge.svg)](https://github.com/robertjorndorff-collab/wandr/actions/workflows/ci.yml)

> Not all who wander are lost.

**Remote command & control for AI coding agents.** Wandr gives you Slack-based observability, command dispatch, and lifecycle management for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions running across multiple projects — from your phone, your couch, or anywhere with Slack.

---

## What It Does

You're a solo developer (or a small team) running multiple AI coding agents across different repos. Each agent is a Claude Code session in a terminal. Wandr sits alongside them and gives you:

- **Live output streaming** — Agent terminal output → Slack, in real time
- **Command dispatch** — Send prompts to any agent from Slack: `!my-agent fix the login bug`
- **Checkpoint protocol** — Automatic status updates: task received, working, complete, stalled
- **Task queue** — Commands queue up if an agent is busy; auto-dispatch when idle
- **Watchdog** — Detects stalled agents, alerts you, auto-restarts on context exhaustion
- **Noise filtering** — Strips TUI artifacts, spinner glyphs, ANSI escape sequences, and repeated lines so Slack output is readable
- **Channel management** — Purge old bot messages to keep your ops channel clean

---

## "I Could Build This in 50 Lines of Bash"

Yes. The core mechanism is `tmux send-keys` + `tail -f` + a Slack webhook. You could wire that up in an afternoon.

Then you'd spend the next three months building:

- The noise filter that turns Claude Code's TUI vomit into readable Slack messages (30+ patterns, ANSI stripping, fragment buffering, dedup, thinking-status throttling)
- The checkpoint state machine that tracks idle/working/stalled transitions and posts clean status lines
- The task queue that holds commands while an agent is busy and auto-dispatches when idle
- The watchdog that detects stalls, alerts you, and auto-restarts on context exhaustion
- The input bridge that survives agent restarts without dropping commands
- The approval gate for dangerous operations
- The line buffer that reassembles character-by-character streaming into complete sentences before forwarding
- The rate-limited Slack transport that batches messages to avoid API throttling
- The Redis-backed message queue that survives sidecar restarts
- The preflight system that checks Redis, Slack auth, port conflicts, and directory permissions before starting

The bash script is the first hour. Wandr is the other 200.

---

## "What About [Tool X]?"

Before you comment "just use [thing]" — I've looked at them:

- **Claude Code `/remote-control`** — It's 1:1. One session, one browser tab. I run multiple agents across different repos simultaneously. I need N:1 in one Slack channel, with queuing, checkpoints, and a watchdog. Remote-control doesn't do that.

- **Goose / Cline / aider / OpenHands** — Those ARE agents. Wandr doesn't replace them. It's the control plane that sits *above* whatever agent you run. Right now it's wired for Claude Code because that's what I use. The architecture is agent-agnostic — the log tailer and input bridge don't care what's in the tmux session.

- **Screen sharing / VS Code Remote / SSH** — Requires me to be at a computer with a screen. The entire point of Wandr is I'm on my phone, on a trail, a mile from my laptop.

I built this because nothing else solved my specific problem: solo builder, multiple AI agents across multiple repos, and I refuse to sit in front of a terminal all day. I'd rather take a walk.

---

## Architecture

```
┌─────────────┐     tee      ┌─────────────────────┐
│ Claude Code  │ ──────────── │ ~/.wandr/logs/X.log │
│ (terminal)   │              └──────────┬──────────┘
│              │                         │ tail
└─────────────┘                          ▼
                               ┌──────────────────┐     flush     ┌─────────┐
                               │  Wandr Sidecar   │ ───────────── │  Slack  │
                               │  (attach mode)   │ ◄─────────── │  #ops   │
                               └──────────────────┘   !agent cmd  └─────────┘
                                         │ write
                                         ▼
                               ┌──────────────────────┐
                               │ ~/.wandr/input/X.cmd │ → tmux send-keys → Claude
                               └──────────────────────┘
```

Wandr **never spawns or owns** your Claude process. It attaches to an existing tmux session, tails the log file, and injects commands via `tmux send-keys`. Your agent doesn't know it's being observed.

---

## Quick Start

### Prerequisites

- Node.js 20+
- Redis (local)
- A Slack workspace with a bot app configured (see [Slack Setup](#slack-setup))
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed

### Install

```bash
git clone https://github.com/YOUR_ORG/wandr.git
cd wandr
npm install
npm run build
```

### Configure

Copy `.env.example` to `.env` and fill in your Slack credentials:

```bash
cp .env.example .env
```

```env
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...
SLACK_CHANNEL_ID=C...        # Your #wandr-ops channel
REDIS_URL=redis://localhost:6379
```

### Start Redis

```bash
redis-server --daemonize yes
```

### Launch an Agent

```bash
# One command: creates tmux session, starts Claude, attaches sidecar
node dist/index.js up my-agent
```

Or use the launch script with project mapping:

```bash
./scripts/wandr-launch.sh my-agent
```

### Send Commands from Slack

```
!my-agent what files are in this directory?
!my-agent fix the failing test in auth.test.ts
!my-agent read README.md and summarize it
```

### Stop

```bash
# Graceful shutdown
node dist/index.js down my-agent

# Or manually
tmux kill-session -t my-agent
```

---

## Agent Naming

Agents use a `{project}-{suffix}` naming convention. The project prefix maps to a directory in `scripts/wandr-launch.sh`:

```bash
case "$PROJECT_PREFIX" in
  myapp)    PROJECT_DIR="$HOME/projects/my-app" ;;
  backend)  PROJECT_DIR="$HOME/projects/backend-api" ;;
  docs)     PROJECT_DIR="$HOME/projects/documentation" ;;
  *)
    echo "Unknown project: $PROJECT_PREFIX"
    exit 1
    ;;
esac
```

Edit this file to add your own projects. The prefix is extracted from the agent ID by stripping everything from the first `-` onward, so `myapp-dev1` → `myapp` → `$HOME/projects/my-app`.

You can also use short names with no suffix (e.g., just `myapp`) — the extraction still works.

---

## Slack Commands

| Command | Description |
|---------|-------------|
| `!{agent} {prompt}` | Send a prompt to the agent |
| `!ping` | Check if sidecar is alive; returns agent state |
| `!purge` | Delete last 100 bot messages from the channel |
| `!purge N` | Delete last N bot messages |
| `!purge all` | Delete all bot messages (paginated) |
| `!clear` | Alias for `!purge` |
| `!lexicon list` | Show registered command keywords |
| `!lexicon add {key} {desc}` | Add a keyword to the lexicon |
| `!lexicon rm {key}` | Remove a keyword |
| `!spec {need}` | Create an on-demand capability ticket |

---

## Checkpoint Protocol

Wandr automatically posts status updates to Slack as your agent works:

| Emoji | Meaning |
|-------|---------|
| 🟢 | **TASK RECEIVED** — prompt dispatched to agent |
| ⏳ | **WORKING** — output still flowing |
| ✅ | **TASK COMPLETE** — idle, awaiting next command |
| 🟡 | **STALLED** — no output for 5 minutes |
| 🔴 | **AGENT DOWN** — tmux session exited or unresponsive |
| 💚 | **HEARTBEAT** — periodic alive check (every 15 min) |
| 📋 | **QUEUED** — command queued while agent is busy |

If a task is dispatched while the agent is busy, it's automatically queued and dispatched when the current task completes.

---

## Noise Filtering

Claude Code's TUI output is noisy — spinner glyphs, ANSI escape sequences, progress counters, prompt chrome. Wandr's log tailer strips all of this before forwarding to Slack:

- ANSI escape sequences → replaced with spaces (preserves word boundaries)
- Spinner glyphs (✱, ✶, ✻, etc.) and thinking status words
- Short fragments (< 5 chars) — almost always TUI artifacts
- Counter/progress numbers
- Claude Code chrome (bypass permissions, prompt arrows, version strings)
- Consecutive duplicate lines (dedup)
- Partial line buffering — fragments assembled before emitting

The filter is in `src/sidecar/log-tailer.ts` → `isNoiseLine()`. Add your own patterns as needed.

---

## Project Structure

```
wandr/
├── src/
│   ├── index.ts              # Entry point (up, down, --attach, spawn modes)
│   ├── config.ts             # Environment config
│   ├── cli/
│   │   ├── up.ts             # tmux session + sidecar lifecycle
│   │   └── preflight.ts      # Startup checks (Redis, Slack, dirs)
│   ├── sidecar/
│   │   ├── log-tailer.ts     # Tails agent log, filters noise, emits lines
│   │   ├── input-bridge.ts   # Slack → .cmd file → tmux send-keys
│   │   ├── checkpoint.ts     # State machine (idle/working/stalled), watchdog
│   │   ├── message-queue.ts  # Redis-backed batched message queue
│   │   ├── slack-transport.ts# Batched Slack message delivery
│   │   ├── state-store.ts    # Redis agent state registry
│   │   ├── approval-gate.ts  # Approval workflow (thread-based)
│   │   └── agent-sidecar.ts  # Legacy spawn mode runner
│   └── api/
│       └── manager-api.ts    # REST API: /status, /health, /digest
├── scripts/
│   ├── wandr-launch.sh       # One-command bootstrap with project mapping
│   └── wandr-start.sh        # Minimal bootstrap (tee + sidecar)
├── config/
│   └── lexicon.json          # Command keyword definitions
├── TICKETS/                  # Work items (markdown)
└── .env                      # Slack tokens, Redis URL (not committed)
```

---

## Runtime Files

```
~/.wandr/
├── logs/
│   ├── {agent-id}.log          # Agent terminal output (tee'd)
│   └── {agent-id}.sidecar.log  # Sidecar process output
├── input/
│   └── {agent-id}.cmd          # Command bridge file
├── registry/
│   └── {agent-id}.dir          # Registered project directory
└── run/
    └── {agent-id}.sidecar.pid  # Sidecar PID file
```

---

## Slack Setup

1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps)
2. Enable **Socket Mode** (Settings → Socket Mode → Enable)
3. Create an **App-Level Token** with `connections:write` scope
4. Add **Bot Token Scopes** under OAuth & Permissions:
   - `chat:write` — post messages
   - `chat:delete` — purge bot messages
   - `channels:history` — read channel history
   - `groups:history` — if using private channels
   - `app_mentions:read` — optional
5. Enable **Event Subscriptions** and subscribe to:
   - `message.groups` (for private channels)
   - `message.channels` (for public channels)
6. Install the app to your workspace
7. Create a channel (e.g., `#wandr-ops`) and invite the bot
8. Copy tokens to `.env`

---

## Stack

| Component | Technology |
|-----------|------------|
| Runtime | Node.js 20+ / TypeScript |
| Message queue | Redis (local) |
| Chat interface | Slack (Bolt SDK, Socket Mode) |
| Agent process | Claude Code CLI in tmux |
| Build | TypeScript compiler (`tsc`) |
| Test | Vitest |
| Lint | ESLint, ruff |

---

## Modes of Operation

### `up` (recommended)

One command to start everything: tmux session, Claude Code, sidecar, log piping.

```bash
node dist/index.js up {agent-id} [--dangerously-skip-permissions]
```

### `down`

Graceful shutdown: kills tmux session and sidecar.

```bash
node dist/index.js down {agent-id}
```

### `--attach`

Attach sidecar to an already-running agent (started manually or via `wandr-start.sh`).

```bash
node dist/index.js --attach {agent-id}
```

### Spawn (legacy)

Runs Claude in print mode (`-p`) per task. No persistent session.

```bash
node dist/index.js {agent-id} claude [flags]
```

---

## Configuration

All configuration is via environment variables (`.env`):

| Variable | Default | Description |
|----------|---------|-------------|
| `SLACK_BOT_TOKEN` | required | Bot OAuth token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | required | App-level token (`xapp-...`) |
| `SLACK_SIGNING_SECRET` | required | App signing secret |
| `SLACK_CHANNEL_ID` | required | Channel ID for ops messages |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection URL |
| `MANAGER_API_PORT` | `9400` | REST API port |
| `FLUSH_INTERVAL_MS` | `2000` | Message batch flush interval |
| `FLUSH_SIZE_LIMIT` | `20` | Max messages per batch |

---

## REST API

The manager API runs on port 9400 by default:

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Liveness check |
| `GET /status` | Agent state and metadata |
| `GET /digest` | Recent activity summary |
| `GET /approvals` | Pending approval requests |

---

## Contributing

1. Fork the repo
2. Create a feature branch
3. Make your changes (follow existing patterns)
4. Run `npm run lint` and `npm test`
5. Submit a PR

---

## License

MIT

---

## AXIS PRAXIS

Wandr is the runtime companion to [AXIS PRAXIS](https://axispraxis.ai) — a governance framework for AI-assisted software development. Where AXIS PRAXIS defines the rules (scope discipline, no fire-and-forget, state sync before deploy, observable behavior), Wandr enforces them through:

- **Checkpoint protocol** — agents report state transitions, not just output
- **Approval gates** — destructive actions require human confirmation
- **Watchdog** — stalled agents are detected and flagged automatically
- **Observable behavior** — all agent activity streams to a shared channel
- **Task queue** — commands are serialized, not fire-and-forget

You don't need AXIS PRAXIS to use Wandr. But if you're thinking about how to govern AI agents responsibly, start there.

---

## Origin

Conceived on a walk in the woods. The name is a portmanteau:

- **Wander** — staying in motion. The best thinking happens when you're not at a desk.
- **Wand** — commanding with a word. Point and speak.

The problem was real: multiple AI coding agents running across different repos, each in its own terminal, and no way to see what they're doing or tell them what to do next without sitting in front of the machine. Wandr was born from wanting to take a walk, open Slack on your phone, and keep the whole operation running — dispatch tasks, read output, catch stalls — while you're a mile from your laptop.

Built for the solo builder running multiple AI agents who refuses to be chained to a terminal.

---

## How We Work

Wandr isn't the output of vibe coding. It's the infrastructure of a one-person product studio.

The workflow: a strategic AI (think product manager) defines the work. Engineering agents execute it. A QA agent validates it. Wandr is the control plane that ties them together — observable, commandable, governed by [AXIS PRAXIS](https://axispraxis.ai).

Will I architect your SOC2 compliant enterprise Kubernetes migration from a state park? No. Will I ship an MVP before you finish your next sprint planning meeting? Absolutely. If you're a solo founder, a small studio, or an indie builder running AI agents seriously, this is the missing piece.
