#!/bin/zsh
set -eo pipefail

# wandr-launch.sh — One command to launch any agent with full Wandr wiring.
# Usage: wandr <agent-id>

AGENT_ID="${1:?Usage: wandr <agent-id>}"
PROJECT_PREFIX="${AGENT_ID%%-*}"

# Resolve project directory from config.
# Reads ~/.wandr/projects.json first, falls back to config/projects.json.
# Copy config/projects.example.json to one of those paths and edit it.
PROJECTS_FILE="$HOME/.wandr/projects.json"
if [[ ! -f "$PROJECTS_FILE" ]]; then
  PROJECTS_FILE="$(dirname "$0")/../config/projects.json"
fi

if [[ ! -f "$PROJECTS_FILE" ]]; then
  echo "No projects config found."
  echo "Copy config/projects.example.json to ~/.wandr/projects.json and add your projects."
  exit 1
fi

# Use node to parse JSON (available since we require Node 20+)
PROJECT_DIR=$(node -e "
  const cfg = require('$PROJECTS_FILE');
  const dir = cfg['$PROJECT_PREFIX'];
  if (!dir) { process.stderr.write('Unknown project: $PROJECT_PREFIX\n'); process.exit(1); }
  console.log(dir.replace(/^~/, process.env.HOME));
")

[[ -d "$PROJECT_DIR" ]] || { echo "Not found: $PROJECT_DIR"; exit 1; }

WANDR_DIR="$HOME/.wandr"
mkdir -p "$WANDR_DIR/logs" "$WANDR_DIR/input"
LOG_FILE="$WANDR_DIR/logs/$AGENT_ID.log"
> "$LOG_FILE"

echo "╔══════════════════════════════════════╗"
echo "║  WANDR — $AGENT_ID"
echo "╠══════════════════════════════════════╣"
echo "║  Project:  $PROJECT_DIR"
echo "║  Channel:  #wandr-ops"
echo "╚══════════════════════════════════════╝"
echo ""

# Resolve Wandr's own directory from this script's location
WANDR_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$WANDR_ROOT"
npx tsx src/index.ts --attach "$AGENT_ID" &
SIDECAR_PID=$!
sleep 3

cleanup() {
  echo "\n[wandr] Shutting down sidecar..."
  kill "$SIDECAR_PID" 2>/dev/null || true
  wait "$SIDECAR_PID" 2>/dev/null || true
}
trap cleanup EXIT

echo "[wandr] Starting Claude in $PROJECT_DIR..."
cd "$PROJECT_DIR"
claude 2>&1 | tee -a "$LOG_FILE"
