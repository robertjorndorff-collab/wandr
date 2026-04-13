#!/bin/bash
# wandr-cold-start.sh — Run after reboot or power loss
set -e

echo "Starting Redis..."
redis-server --daemonize yes

echo "Starting Wandr..."
cd ~/Desktop/Wandr
node dist/index.js up wandr
node dist/index.js up ljs

echo "Done. Wandr + LJS online."
