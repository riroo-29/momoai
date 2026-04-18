#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
STATE_FILE="$ROOT/.codex_bridge_public_url"

cd "$ROOT"

MAX_RETRY=4
TRY=1
URL=""
BASE=""

while (( TRY <= MAX_RETRY )); do
  echo "[1/3] restarting bridge + tunnel... (try ${TRY}/${MAX_RETRY})"
  ./stop_codex_bridge_public.sh >/dev/null 2>&1 || true
  OUT="$(./start_codex_bridge_public.sh)"
  echo "$OUT"

  URL="$(echo "$OUT" | sed -n 's/^codex_bridge_public_run_task_url=//p' | tail -n 1)"
  if [[ -z "$URL" && -f "$STATE_FILE" ]]; then
    URL="$(cat "$STATE_FILE" 2>/dev/null || true)"
  fi
  if [[ -z "$URL" ]]; then
    TRY=$((TRY + 1))
    sleep 1
    continue
  fi

  BASE="${URL%/run-task}"
  echo ""
  echo "[2/3] quick check..."
  if curl -fsS "$BASE/health" >/dev/null; then
    echo "health ok: $BASE/health"
    break
  fi

  echo "health check failed, recreating tunnel..."
  TRY=$((TRY + 1))
  sleep 1
done

if [[ -z "$URL" || -z "$BASE" ]]; then
  echo ""
  echo "[error] bridge url not found"
  exit 1
fi

if ! curl -fsS "$BASE/health" >/dev/null; then
  echo ""
  echo "[error] all retries failed. run again in 1-2 minutes."
  exit 1
fi

echo ""
echo "[3/3] copy this into Cloudflare Pages variable CODEX_BRIDGE_URL:"
echo "$URL"
echo ""
echo "Then open Cloudflare -> momoai -> Settings -> Variables and Secrets -> CODEX_BRIDGE_URL and update."
echo "After update, run Retry deployment once."
