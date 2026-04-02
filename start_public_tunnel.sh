#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$ROOT/.cloudflared.pid"
LOG_FILE="/tmp/ai_character_tunnel.log"

cd "$ROOT"

if [[ ! -f "$ROOT/.env" ]]; then
  echo "missing_env_file"
  exit 1
fi

source "$ROOT/.env"

if [[ -z "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]]; then
  echo "missing_cloudflare_tunnel_token"
  echo "Set CLOUDFLARE_TUNNEL_TOKEN in .env"
  exit 1
fi

if [[ ! -x "$ROOT/bin/cloudflared" ]]; then
  echo "missing_cloudflared_binary"
  echo "Place cloudflared at $ROOT/bin/cloudflared"
  exit 1
fi

if [[ -f "$PID_FILE" ]]; then
  OLD_PID="$(cat "$PID_FILE" || true)"
  if [[ -n "${OLD_PID}" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "tunnel_already_running pid=$OLD_PID"
    if [[ -n "${PUBLIC_BASE_URL:-}" ]]; then
      echo "public_url=$PUBLIC_BASE_URL"
    fi
    exit 0
  fi
fi

# Tokenを環境変数として子プロセスへ渡さない（ログ露出防止）
nohup "$ROOT/bin/cloudflared" tunnel --no-autoupdate run --token "$CLOUDFLARE_TUNNEL_TOKEN" >> "$LOG_FILE" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$PID_FILE"

sleep 1
if ! kill -0 "$NEW_PID" 2>/dev/null; then
  echo "tunnel_failed_to_start"
  tail -n 60 "$LOG_FILE" || true
  exit 1
fi

echo "tunnel_started pid=$NEW_PID"
if [[ -n "${PUBLIC_BASE_URL:-}" ]]; then
  echo "public_url=$PUBLIC_BASE_URL"
else
  echo "public_url=(set PUBLIC_BASE_URL in .env to show your fixed URL)"
fi
