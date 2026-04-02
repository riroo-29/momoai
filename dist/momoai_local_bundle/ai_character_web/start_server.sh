#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$ROOT/.server.pid"
LOG_FILE="/tmp/ai_character_web.log"

cd "$ROOT"
set -a
source .env
set +a

if [[ -f "$PID_FILE" ]]; then
  OLD_PID="$(cat "$PID_FILE" || true)"
  if [[ -n "${OLD_PID}" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "server_already_running pid=$OLD_PID"
    exit 0
  fi
fi

nohup python3 server.py >> "$LOG_FILE" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$PID_FILE"

echo "server_started pid=$NEW_PID"
