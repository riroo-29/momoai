#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$ROOT/.quick_tunnel.pid"

if [[ ! -f "$PID_FILE" ]]; then
  echo "quick_tunnel_not_running"
  exit 0
fi

PID="$(cat "$PID_FILE" || true)"
if [[ -n "${PID}" ]] && kill -0 "$PID" 2>/dev/null; then
  kill "$PID" || true
fi

rm -f "$PID_FILE"
echo "quick_tunnel_stopped"
