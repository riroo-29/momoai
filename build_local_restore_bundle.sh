#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
DIST="$ROOT/dist"
STAGE="$DIST/momoai_local_bundle"
OUT="$DIST/momoai_local_restore_bundle.tar.gz"

rm -rf "$STAGE"
mkdir -p "$STAGE/ai_character_web/static" "$STAGE/ai_character_web/bin"

# Core app files
cp "$ROOT/server.py" "$STAGE/ai_character_web/"
cp "$ROOT/.env.example" "$STAGE/ai_character_web/"
cp "$ROOT/README.md" "$STAGE/ai_character_web/"
cp "$ROOT/CODEX_README_momoai.md" "$STAGE/ai_character_web/"

# Run scripts
cp "$ROOT/start_server.sh" "$STAGE/ai_character_web/"
cp "$ROOT/stop_server.sh" "$STAGE/ai_character_web/"
cp "$ROOT/restart_server_safe.sh" "$STAGE/ai_character_web/"
cp "$ROOT/start_free_public_url.sh" "$STAGE/ai_character_web/"
cp "$ROOT/stop_free_public_url.sh" "$STAGE/ai_character_web/"

# Frontend runtime files
cp "$ROOT/static/index.html" "$STAGE/ai_character_web/static/"
cp "$ROOT/static/styles.css" "$STAGE/ai_character_web/static/"
cp "$ROOT/static/app.js" "$STAGE/ai_character_web/static/"
cp "$ROOT/static/voice_idle.mp4" "$STAGE/ai_character_web/static/"
cp "$ROOT/static/voice_speaking.mp4" "$STAGE/ai_character_web/static/"
cp "$ROOT/static/character-placeholder.svg" "$STAGE/ai_character_web/static/"

# cloudflared binary if present
if [[ -x "$ROOT/bin/cloudflared" ]]; then
  cp "$ROOT/bin/cloudflared" "$STAGE/ai_character_web/bin/"
fi

cat > "$STAGE/RUN_ME_FIRST.sh" <<'RUN'
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
RUN

chmod +x "$STAGE/RUN_ME_FIRST.sh"
chmod +x "$STAGE/ai_character_web"/*.sh

rm -f "$OUT"
cd "$DIST"
tar -czf "$OUT" momoai_local_bundle

echo "bundle_created=$OUT"
ls -lh "$OUT"
