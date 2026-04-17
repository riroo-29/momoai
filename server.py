#!/usr/bin/env python3
import json
import os
import shlex
import subprocess
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib import error, request
from urllib.parse import parse_qs, quote, urlparse
from datetime import datetime, timezone, timedelta

HOST = os.getenv("HOST", "127.0.0.1")
PORT = int(os.getenv("PORT", "8000"))
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
GEMINI_LIVE_MODEL = os.getenv("GEMINI_LIVE_MODEL", "gemini-3.1-flash-live-preview")
LOCAL_TOOL_MODE = os.getenv("LOCAL_TOOL_MODE", "1") == "1"
CODEX_BRIDGE_URL = os.getenv("CODEX_BRIDGE_URL", "").strip()
CODEX_BRIDGE_TOKEN = os.getenv("CODEX_BRIDGE_TOKEN", "").strip()

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
CODEX_TASK_DIR = ROOT / "codex_tasks"
MAX_TURNS = 12
TOOL_TIMEOUT_SEC = 15

ALLOWED_COMMANDS = {
    ("pwd",),
    ("ls",),
    ("ls", "-la"),
    ("git", "status"),
    ("git", "log", "--oneline", "-n", "5"),
    ("git", "branch"),
    ("python3", "--version"),
    ("node", "--version"),
}

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
        return "gemini-3.1-flash-live-preview"

    no_prefix = raw[7:] if raw.startswith("models/") else raw
    aliases = {
        "gemini-2.5-flash-live-preview": "gemini-3.1-flash-live-preview",
        "gemini-live-2.5-flash-preview": "gemini-3.1-flash-live-preview",
        "gemini-2.0-flash-live-001": "gemini-3.1-flash-live-preview",
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


def call_gemini_google_search(query: str) -> dict:
    if not GEMINI_API_KEY:
        raise RuntimeError("GEMINI_API_KEY が未設定です。")

    payload = {
        "contents": [
            {
                "role": "user",
                "parts": [
                    {
                        "text": f"次の質問に対してGoogle検索を使って最新情報を確認し、日本語で簡潔に要約してください: {query}"
                    }
                ],
            }
        ],
        "tools": [{"google_search": {}}],
        "generationConfig": {"temperature": 0.2},
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
        raise RuntimeError(f"Google検索API error ({e.code}): {detail}") from e
    except Exception as e:
        raise RuntimeError(f"Google検索API request failed: {e}") from e

    try:
        parts = body["candidates"][0]["content"]["parts"]
        summary = "".join(part.get("text", "") for part in parts).strip()
    except Exception:
        summary = ""

    chunks = (
        body.get("candidates", [{}])[0]
        .get("groundingMetadata", {})
        .get("groundingChunks", [])
    )
    sources = []
    seen = set()
    for chunk in chunks:
        web = chunk.get("web", {})
        uri = web.get("uri", "")
        if not uri or uri in seen:
            continue
        seen.add(uri)
        sources.append(
            {
                "title": web.get("title") or uri,
                "url": uri,
            }
        )
    return {
        "query": query,
        "summary": summary or "要約を取得できませんでした。",
        "sources": sources[:8],
        "model": GEMINI_MODEL,
    }


def build_now_info() -> dict:
    jst = timezone(timedelta(hours=9))
    now = datetime.now(jst)
    weekday = ["月", "火", "水", "木", "金", "土", "日"][now.weekday()]
    return {
        "nowIso": now.astimezone(timezone.utc).isoformat(),
        "timezone": "Asia/Tokyo",
        "nowJst": now.strftime(f"%Y/%m/%d({weekday}) %H:%M:%S"),
    }


def is_allowed_command(parts: list[str]) -> bool:
    if not parts:
        return False
    cmd = tuple(parts)
    if cmd in ALLOWED_COMMANDS:
        return True
    # npm run <script> はローカル開発で利用頻度が高いので許可
    if len(parts) == 3 and parts[0] == "npm" and parts[1] == "run":
        return True
    return False


def run_safe_command(command: str) -> dict:
    parts = shlex.split(command.strip())
    if not is_allowed_command(parts):
        raise RuntimeError("このコマンドは許可リスト外です。")
    proc = subprocess.run(
        parts,
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        timeout=TOOL_TIMEOUT_SEC,
    )
    return {
        "command": command,
        "returnCode": proc.returncode,
        "stdout": (proc.stdout or "").strip()[:12000],
        "stderr": (proc.stderr or "").strip()[:12000],
    }


def open_target_url(target_url: str) -> bool:
    url = (target_url or "").strip()
    if not url:
        raise RuntimeError("url が空です")
    # 危険なスキームは拒否
    if not (
        url.startswith("http://")
        or url.startswith("https://")
        or url.startswith("instagram://")
        or url.startswith("line://")
        or url.startswith("youtube://")
    ):
        raise RuntimeError("許可されていないURLスキームです。")
    return webbrowser.open(url, new=2)


def dispatch_codex_task(task: str) -> dict:
    clean_task = (task or "").strip()
    if not clean_task:
        raise RuntimeError("task が空です")

    if CODEX_BRIDGE_URL:
        payload = {
            "task": clean_task,
            "source": "momo_voice_app_local",
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        headers = {"Content-Type": "application/json"}
        if CODEX_BRIDGE_TOKEN:
            headers["Authorization"] = f"Bearer {CODEX_BRIDGE_TOKEN}"
        req = request.Request(
            CODEX_BRIDGE_URL,
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        try:
            with request.urlopen(req, timeout=20) as res:
                data = json.loads(res.read().decode("utf-8"))
        except error.HTTPError as e:
            detail = e.read().decode("utf-8", errors="ignore")
            raise RuntimeError(f"Codex bridge error ({e.code}): {detail}") from e
        except Exception as e:
            raise RuntimeError(f"Codex bridge request failed: {e}") from e
        return {
            "status": "sent",
            "bridge": CODEX_BRIDGE_URL,
            "response": data,
        }

    # bridge未設定時はローカルキューへ保存（後で処理可能）
    CODEX_TASK_DIR.mkdir(parents=True, exist_ok=True)
    task_id = f"codex-{int(datetime.now().timestamp() * 1000)}"
    item = {
        "id": task_id,
        "task": clean_task,
        "source": "momo_voice_app_local",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "status": "queued",
    }
    queue_file = CODEX_TASK_DIR / "pending.jsonl"
    with queue_file.open("a", encoding="utf-8") as f:
        f.write(json.dumps(item, ensure_ascii=False) + "\n")
    return {
        "status": "queued",
        "taskId": task_id,
        "queueFile": str(queue_file),
        "message": "CODEX_BRIDGE_URL が未設定のため、ローカルキューに保存しました。",
    }


def fetch_codex_task_status(task_id: str) -> dict:
    tid = (task_id or "").strip()
    if not tid:
        raise RuntimeError("id が空です")
    if not CODEX_BRIDGE_URL:
        raise RuntimeError("CODEX_BRIDGE_URL 未設定です")

    u = urlparse(CODEX_BRIDGE_URL)
    bridge_root = f"{u.scheme}://{u.netloc}"
    status_url = f"{bridge_root}/tasks/{quote(tid, safe='')}"
    headers = {}
    if CODEX_BRIDGE_TOKEN:
        headers["Authorization"] = f"Bearer {CODEX_BRIDGE_TOKEN}"
    req = request.Request(status_url, headers=headers, method="GET")
    try:
        with request.urlopen(req, timeout=20) as res:
            data = json.loads(res.read().decode("utf-8"))
    except error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"Codex bridge status error ({e.code}): {detail}") from e
    except Exception as e:
        raise RuntimeError(f"Codex bridge status request failed: {e}") from e
    return {"task": data.get("task"), "raw": data}


class AppHandler(SimpleHTTPRequestHandler):
    def translate_path(self, path: str) -> str:
        # Serve static files from ./static
        raw = super().translate_path(path)
        rel = Path(raw).relative_to(Path.cwd())
        return str(STATIC_DIR / rel)

    def do_POST(self):
        if self.path == "/api/codex/task":
            try:
                length = int(self.headers.get("Content-Length", "0"))
                data = self.rfile.read(length)
                payload = json.loads(data.decode("utf-8"))
                task = (payload.get("task") or "").strip()
                if not task:
                    self.respond_json(400, {"error": "task が空です"})
                    return
                result = dispatch_codex_task(task)
                self.respond_json(200, {"ok": True, "result": result})
            except Exception as e:
                self.respond_json(500, {"error": str(e)})
            return

        if self.path == "/api/tools/open":
            if not LOCAL_TOOL_MODE:
                self.respond_json(403, {"error": "LOCAL_TOOL_MODE が無効です"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                data = self.rfile.read(length)
                payload = json.loads(data.decode("utf-8"))
                url = (payload.get("url") or "").strip()
                opened = open_target_url(url)
                self.respond_json(200, {"ok": True, "opened": bool(opened), "url": url})
            except Exception as e:
                self.respond_json(500, {"error": str(e)})
            return

        if self.path == "/api/tools/exec":
            if not LOCAL_TOOL_MODE:
                self.respond_json(403, {"error": "LOCAL_TOOL_MODE が無効です"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                data = self.rfile.read(length)
                payload = json.loads(data.decode("utf-8"))
                command = (payload.get("command") or "").strip()
                if not command:
                    self.respond_json(400, {"error": "command が空です"})
                    return
                result = run_safe_command(command)
                self.respond_json(200, {"ok": True, "result": result})
            except Exception as e:
                self.respond_json(500, {"error": str(e)})
            return

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
        parsed = urlparse(self.path)
        if parsed.path == "/api/live-config":
            self.respond_json(
                200,
                {
                    "apiKey": GEMINI_API_KEY,
                    "liveModel": normalize_live_model_name(GEMINI_LIVE_MODEL),
                },
            )
            return
        if parsed.path == "/api/now":
            self.respond_json(200, build_now_info())
            return
        if parsed.path == "/api/search":
            params = parse_qs(parsed.query)
            q = (params.get("q", [""])[0] or "").strip()
            if not q:
                self.respond_json(400, {"error": "q が空です"})
                return
            try:
                result = call_gemini_google_search(q)
                self.respond_json(200, result)
            except Exception as e:
                self.respond_json(500, {"error": str(e)})
            return
        if parsed.path == "/api/tools/status":
            self.respond_json(
                200,
                {
                    "localToolMode": LOCAL_TOOL_MODE,
                    "allowedCommands": [" ".join(c) for c in sorted(ALLOWED_COMMANDS)] + ["npm run <script>"],
                    "root": str(ROOT),
                },
            )
            return
        if parsed.path == "/api/codex/task-status":
            params = parse_qs(parsed.query)
            tid = (params.get("id", [""])[0] or "").strip()
            if not tid:
                self.respond_json(400, {"error": "id が空です"})
                return
            try:
                result = fetch_codex_task_status(tid)
                self.respond_json(200, {"ok": True, "result": result})
            except Exception as e:
                self.respond_json(500, {"error": str(e)})
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
