#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
BRIDGE_PID_FILE="$ROOT/.codex_bridge.pid"
TUNNEL_PID_FILE="$ROOT/.codex_bridge_tunnel.pid"
BRIDGE_LOG="/tmp/codex_bridge.log"
TUNNEL_LOG="/tmp/codex_bridge_tunnel.log"
STATE_FILE="$ROOT/.codex_bridge_public_url"

cd "$ROOT"

if [[ ! -f "$ROOT/.env" ]]; then
  echo "missing_env_file"
  exit 1
fi

source "$ROOT/.env"

if [[ -z "${CODEX_BRIDGE_TOKEN:-}" ]]; then
  echo "missing_codex_bridge_token_in_env"
  echo "set CODEX_BRIDGE_TOKEN in .env"
  exit 1
fi

if [[ ! -x "$ROOT/bin/cloudflared" ]]; then
  echo "missing_cloudflared_binary"
  exit 1
fi

# Named Tunnel (fixed URL) settings
BRIDGE_NAMED_TOKEN="${CLOUDFLARE_TUNNEL_TOKEN_BRIDGE:-${CLOUDFLARE_TUNNEL_TOKEN:-}}"
BRIDGE_FIXED_URL="${CODEX_BRIDGE_FIXED_URL:-}"

# stop existing
for file in "$TUNNEL_PID_FILE" "$BRIDGE_PID_FILE"; do
  if [[ -f "$file" ]]; then
    OLD_PID="$(cat "$file" || true)"
    if [[ -n "${OLD_PID}" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
      kill "$OLD_PID" || true
    fi
    rm -f "$file"
  fi
done

rm -f "$BRIDGE_LOG" "$TUNNEL_LOG" "$STATE_FILE"

# start bridge (Codex exec non-interactive)
nohup env \
  BRIDGE_HOST=127.0.0.1 \
  BRIDGE_PORT=8787 \
  BRIDGE_TOKEN="$CODEX_BRIDGE_TOKEN" \
  MOMO_CEO_FILE="${MOMO_CEO_FILE:-$ROOT/../momo.CEO/momo.CEO}" \
  CODEX_CLI="${CODEX_CLI:-codex}" \
  CODEX_FIXED_ARGS="${CODEX_FIXED_ARGS:-exec --skip-git-repo-check --full-auto}" \
  CODEX_TASK_PREFIX="${CODEX_TASK_PREFIX:-作業対象は /Users/jumpeiokada/Library/Mobile Documents/com~apple~CloudDocs/obsidian/momo.CEO ディレクトリ。可能な限りこの配下で作業し、結果は /Users/jumpeiokada/Library/Mobile Documents/com~apple~CloudDocs/obsidian/momo.CEO/momo.CEO に反映して。依頼: }" \
  python3 "$ROOT/tools/windows_codex_bridge.py" > "$BRIDGE_LOG" 2>&1 &
BRIDGE_PID=$!
echo "$BRIDGE_PID" > "$BRIDGE_PID_FILE"

sleep 1
if ! kill -0 "$BRIDGE_PID" 2>/dev/null; then
  echo "bridge_failed"
  tail -n 80 "$BRIDGE_LOG" || true
  exit 1
fi

# local health
if ! curl -fsS "http://127.0.0.1:8787/health" >/dev/null; then
  echo "bridge_health_failed"
  tail -n 80 "$BRIDGE_LOG" || true
  exit 1
fi

if [[ -n "$BRIDGE_NAMED_TOKEN" && -n "$BRIDGE_FIXED_URL" ]]; then
  # start named tunnel for bridge (fixed URL)
  nohup "$ROOT/bin/cloudflared" tunnel --no-autoupdate run --token "$BRIDGE_NAMED_TOKEN" > "$TUNNEL_LOG" 2>&1 &
  TUNNEL_PID=$!
  echo "$TUNNEL_PID" > "$TUNNEL_PID_FILE"

  for i in {1..30}; do
    if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
      echo "bridge_named_tunnel_failed"
      tail -n 80 "$TUNNEL_LOG" || true
      exit 1
    fi
    sleep 1
  done

  echo "$BRIDGE_FIXED_URL" > "$STATE_FILE"
  echo "codex_bridge_started pid=$BRIDGE_PID"
  echo "codex_bridge_tunnel_started pid=$TUNNEL_PID"
  echo "codex_bridge_mode=named_tunnel"
  echo "codex_bridge_public_run_task_url=$BRIDGE_FIXED_URL"
  echo "note=ensure tunnel public hostname routes to http://127.0.0.1:8787"
else
  # start quick tunnel for bridge (temporary URL)
  nohup "$ROOT/bin/cloudflared" tunnel --url http://127.0.0.1:8787 --no-autoupdate > "$TUNNEL_LOG" 2>&1 &
  TUNNEL_PID=$!
  echo "$TUNNEL_PID" > "$TUNNEL_PID_FILE"

  URL=""
  for i in {1..30}; do
    if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
      echo "bridge_tunnel_failed"
      tail -n 80 "$TUNNEL_LOG" || true
      exit 1
    fi
    URL="$(rg -o 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -n 1 || true)"
    if [[ -n "$URL" ]]; then
      break
    fi
    sleep 1
  done

  if [[ -z "$URL" ]]; then
    echo "bridge_tunnel_started pid=$TUNNEL_PID"
    echo "url_not_found_yet"
    tail -n 40 "$TUNNEL_LOG" || true
    exit 1
  fi

  echo "$URL/run-task" > "$STATE_FILE"
  echo "codex_bridge_started pid=$BRIDGE_PID"
  echo "codex_bridge_tunnel_started pid=$TUNNEL_PID"
  echo "codex_bridge_mode=quick_tunnel"
  echo "codex_bridge_public_run_task_url=$URL/run-task"
fi
