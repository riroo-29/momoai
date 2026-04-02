#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# 1) 新コードが壊れていないかを先に確認
python3 -m py_compile server.py

# 2) 既存停止→新規起動
"$ROOT/stop_server.sh"
"$ROOT/start_server.sh"

# 3) ヘルスチェック
sleep 1
curl -fsS "http://127.0.0.1:8000/" >/dev/null

echo "server_healthy"
