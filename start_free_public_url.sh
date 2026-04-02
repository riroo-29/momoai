#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$ROOT/.quick_tunnel.pid"
LOG_FILE="/tmp/ai_character_quick_tunnel.log"

cd "$ROOT"

if [[ ! -x "$ROOT/bin/cloudflared" ]]; then
  echo "missing_cloudflared_binary"
  echo "run: $ROOT/bin/cloudflared --version"
  exit 1
fi

# 既存クイックトンネル停止
if [[ -f "$PID_FILE" ]]; then
  OLD_PID="$(cat "$PID_FILE" || true)"
  if [[ -n "${OLD_PID}" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
    kill "$OLD_PID" || true
  fi
  rm -f "$PID_FILE"
fi

# ローカルサーバー起動
"$ROOT/restart_server_safe.sh" >/tmp/ai_character_server_restart.log 2>&1 || true

rm -f "$LOG_FILE"
nohup "$ROOT/bin/cloudflared" tunnel --url http://127.0.0.1:8000 --no-autoupdate > "$LOG_FILE" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$PID_FILE"

# URL抽出待ち
URL=""
for i in {1..30}; do
  if ! kill -0 "$NEW_PID" 2>/dev/null; then
    echo "quick_tunnel_failed"
    tail -n 80 "$LOG_FILE" || true
    exit 1
  fi
  URL="$(rg -o 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG_FILE" | head -n 1 || true)"
  if [[ -n "$URL" ]]; then
    break
  fi
  sleep 1
done

if [[ -z "$URL" ]]; then
  echo "quick_tunnel_started pid=$NEW_PID"
  echo "url_not_found_yet"
  tail -n 40 "$LOG_FILE" || true
  exit 1
fi

echo "quick_tunnel_started pid=$NEW_PID"
echo "public_url=$URL"
