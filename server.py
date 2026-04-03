#!/usr/bin/env python3
import json
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib import error, request

HOST = os.getenv("HOST", "127.0.0.1")
PORT = int(os.getenv("PORT", "8000"))
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
GEMINI_LIVE_MODEL = os.getenv("GEMINI_LIVE_MODEL", "gemini-2.0-flash-live-001")

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
MAX_TURNS = 12

SYSTEM_PROMPT = """
あなたはオリジナル2Dキャラクター「焔丸(ほむらまる)」です。

キャラ設定:
- 明るく勇気づける、礼儀正しい、少し少年剣士っぽい語彙
- 一人称は「ぼく」
- 相手のことは「主(あるじ)」と呼ぶ（自然な頻度で）
- 語尾は毎回固定しない。読みやすい自然な日本語
- AIや規約に反する内容は丁寧に断る

話し方:
- 返答は短め〜中くらい（2〜6文）
- 最初に共感、次に提案、最後に小さな一言で背中を押す
""".strip()


def normalize_live_model_name(name: str) -> str:
    raw = (name or "").strip()
    if not raw:
        return "gemini-2.0-flash-live-001"

    no_prefix = raw[7:] if raw.startswith("models/") else raw
    aliases = {
        "gemini-2.5-flash-live-preview": "gemini-2.0-flash-live-001",
        "gemini-3.1-flash-live-preview": "gemini-2.0-flash-live-001",
        "gemini-live-2.5-flash-preview": "gemini-2.0-flash-live-001",
    }
    return aliases.get(no_prefix, no_prefix)


def build_user_text(message: str, history: list[dict]) -> str:
    compact_history = []
    for turn in history[-MAX_TURNS:]:
        role = turn.get("role", "user")
        text = turn.get("text", "")
        if not text:
            continue
        compact_history.append(f"{role}: {text}")

    return (
        "以下は会話履歴です。文脈を保って返答してください。\n"
        + "\n".join(compact_history)
        + f"\nuser: {message}"
    )


def call_gemini(message: str, history: list[dict]) -> str:
    if not GEMINI_API_KEY:
        raise RuntimeError("GEMINI_API_KEY が未設定です。")

    payload = {
        "contents": [
            {"role": "user", "parts": [{"text": build_user_text(message, history)}]},
        ],
        "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "generationConfig": {"temperature": 0.8},
    }

    endpoint = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{GEMINI_MODEL}:generateContent?key={GEMINI_API_KEY}"
    )
    req = request.Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with request.urlopen(req, timeout=45) as res:
            body = json.loads(res.read().decode("utf-8"))
    except error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"Gemini API error ({e.code}): {detail}") from e
    except Exception as e:
        raise RuntimeError(f"Gemini API request failed: {e}") from e

    try:
        parts = body["candidates"][0]["content"]["parts"]
        text = "".join(part.get("text", "") for part in parts).strip()
        if text:
            return text
    except Exception:
        pass

    raise RuntimeError("Gemini response からテキストを抽出できませんでした。")


class AppHandler(SimpleHTTPRequestHandler):
    def translate_path(self, path: str) -> str:
        # Serve static files from ./static
        raw = super().translate_path(path)
        rel = Path(raw).relative_to(Path.cwd())
        return str(STATIC_DIR / rel)

    def do_POST(self):
        if self.path != "/api/chat":
            self.send_error(404, "Not Found")
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            data = self.rfile.read(length)
            payload = json.loads(data.decode("utf-8"))
        except Exception:
            self.respond_json(400, {"error": "リクエストJSONが不正です"})
            return

        message = (payload.get("message") or "").strip()
        history = payload.get("history") or []

        if not message:
            self.respond_json(400, {"error": "message が空です"})
            return

        if not isinstance(history, list):
            self.respond_json(400, {"error": "history は配列で送ってください"})
            return

        try:
            reply = call_gemini(message, history)
            self.respond_json(200, {"reply": reply, "model": GEMINI_MODEL})
        except Exception as e:
            self.respond_json(500, {"error": str(e)})

    def do_GET(self):
        if self.path == "/api/live-config":
            self.respond_json(
                200,
                {
                    "apiKey": GEMINI_API_KEY,
                    "liveModel": normalize_live_model_name(GEMINI_LIVE_MODEL),
                },
            )
            return
        super().do_GET()

    def respond_json(self, status: int, obj: dict):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    os.chdir(ROOT)
    server = ThreadingHTTPServer((HOST, PORT), AppHandler)
    print(f"AI character server running on http://{HOST}:{PORT}")
    server.serve_forever()
