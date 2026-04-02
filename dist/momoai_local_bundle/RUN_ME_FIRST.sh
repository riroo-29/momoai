#!/bin/zsh
set -euo pipefail

cd "$(dirname "$0")/ai_character_web"

if [[ ! -f .env ]]; then
  cp .env.example .env
fi

echo "--------------------------------------------------"
echo "1) Edit .env and set GEMINI_API_KEY"
echo "2) Then run: ./restart_server_safe.sh"
echo "3) Open: http://127.0.0.1:8000"
echo "--------------------------------------------------"
