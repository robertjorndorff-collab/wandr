#!/bin/bash
# wandr-start.sh — thin shim around `wandr up`.
# Usage: wandr-start.sh <agent-id> [extra-claude-flags...]
set -euo pipefail
exec node "$(dirname "$0")/../dist/index.js" up "$@"
