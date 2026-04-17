#!/usr/bin/env python3
import json
import os
import secrets
import subprocess
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST = os.getenv("BRIDGE_HOST", "0.0.0.0")
PORT = int(os.getenv("BRIDGE_PORT", "8787"))
BRIDGE_TOKEN = os.getenv("BRIDGE_TOKEN", "").strip()
CODEX_CLI = os.getenv("CODEX_CLI", "codex").strip() or "codex"
CODEX_FIXED_ARGS = os.getenv("CODEX_FIXED_ARGS", "").strip()
CODEX_TASK_PREFIX = os.getenv("CODEX_TASK_PREFIX", "").strip()
CODEX_RUN_TIMEOUT_SEC = int(os.getenv("CODEX_RUN_TIMEOUT_SEC", "1800"))
MAX_STDOUT = int(os.getenv("BRIDGE_MAX_STDOUT", "20000"))
MAX_STDERR = int(os.getenv("BRIDGE_MAX_STDERR", "12000"))
MOMO_CEO_FILE = (os.getenv("MOMO_CEO_FILE", "") or "").strip()

TASKS = {}
TASKS_LOCK = threading.Lock()
FILE_LOCK = threading.Lock()


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def split_fixed_args(s: str) -> list[str]:
    if not s:
        return []
    # simple split for windows cmd style (space separated). Keep it minimal.
    return [x for x in s.split(" ") if x]


def resolve_momo_ceo_file() -> Path | None:
    if MOMO_CEO_FILE:
        return Path(MOMO_CEO_FILE).expanduser()
    # default: repo sibling folder ../momo.CEO/momo.CEO
    candidate = (Path.cwd().resolve().parent / "momo.CEO" / "momo.CEO")
    if candidate.exists():
        return candidate
    return None


def append_history(task_id: str, task_text: str, status: str, return_code, stdout: str, stderr: str, error_text: str):
    target = resolve_momo_ceo_file()
    if not target:
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    now_local = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    out = (stdout or "").strip()
    err = (stderr or "").strip()
    fallback = (error_text or "").strip()
    response = out or err or fallback or "(no output)"
    if len(response) > 4000:
        response = response[:4000] + " ...[truncated]"

    block = (
        "\n\n---\n"
        f"## Codex Task {task_id}\n"
        f"- At: {now_local}\n"
        f"- Status: {status}\n"
        f"- ReturnCode: {return_code}\n"
        f"- Instruction: {task_text}\n\n"
        "### Response\n"
        "```\n"
        f"{response}\n"
        "```\n"
    )

    with FILE_LOCK:
        with target.open("a", encoding="utf-8") as f:
            f.write(block)


def build_command(task: str) -> list[str]:
    clean = (task or "").strip()
    if not clean:
        raise RuntimeError("task is empty")
    merged = f"{CODEX_TASK_PREFIX}{clean}" if CODEX_TASK_PREFIX else clean
    cmd = [CODEX_CLI]
    cmd.extend(split_fixed_args(CODEX_FIXED_ARGS))
    cmd.append(merged)
    return cmd


def create_task(task_text: str) -> dict:
    task_id = f"task-{int(datetime.now().timestamp() * 1000)}-{secrets.token_hex(3)}"
    item = {
        "id": task_id,
        "task": task_text,
        "status": "queued",
        "createdAt": utc_now(),
        "updatedAt": utc_now(),
        "command": None,
        "returnCode": None,
        "stdout": "",
        "stderr": "",
        "error": "",
    }
    with TASKS_LOCK:
        TASKS[task_id] = item
    return item


def update_task(task_id: str, **fields):
    with TASKS_LOCK:
        item = TASKS.get(task_id)
        if not item:
            return
        item.update(fields)
        item["updatedAt"] = utc_now()


def run_task(task_id: str):
    with TASKS_LOCK:
        item = TASKS.get(task_id)
    if not item:
        return
    task_text = item.get("task", "")
    try:
        cmd = build_command(task_text)
        update_task(task_id, status="running", command=cmd)
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=CODEX_RUN_TIMEOUT_SEC,
            shell=False,
        )
        update_task(
            task_id,
            status="done" if proc.returncode == 0 else "failed",
            returnCode=proc.returncode,
            stdout=(proc.stdout or "")[:MAX_STDOUT],
            stderr=(proc.stderr or "")[:MAX_STDERR],
        )
        append_history(
            task_id=task_id,
            task_text=task_text,
            status="done" if proc.returncode == 0 else "failed",
            return_code=proc.returncode,
            stdout=(proc.stdout or "")[:MAX_STDOUT],
            stderr=(proc.stderr or "")[:MAX_STDERR],
            error_text="",
        )
    except Exception as e:
        update_task(task_id, status="failed", error=str(e))
        append_history(
            task_id=task_id,
            task_text=task_text,
            status="failed",
            return_code=None,
            stdout="",
            stderr="",
            error_text=str(e),
        )


def auth_ok(headers) -> bool:
    if not BRIDGE_TOKEN:
        return True
    auth = headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return False
    token = auth[len("Bearer ") :].strip()
    return token == BRIDGE_TOKEN


class Handler(BaseHTTPRequestHandler):
    def _json(self, status: int, data: dict):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._json(
                200,
                {
                    "ok": True,
                    "service": "windows-codex-bridge",
                    "time": utc_now(),
                    "tokenProtected": bool(BRIDGE_TOKEN),
                    "codexCli": CODEX_CLI,
                },
            )
            return

        if self.path.startswith("/tasks/"):
            task_id = self.path.split("/tasks/", 1)[1].strip()
            with TASKS_LOCK:
                item = TASKS.get(task_id)
            if not item:
                self._json(404, {"ok": False, "error": "task not found"})
                return
            self._json(200, {"ok": True, "task": item})
            return

        self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if self.path != "/run-task":
            self._json(404, {"ok": False, "error": "not found"})
            return
        if not auth_ok(self.headers):
            self._json(401, {"ok": False, "error": "unauthorized"})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length).decode("utf-8")
            data = json.loads(raw) if raw else {}
        except Exception:
            self._json(400, {"ok": False, "error": "invalid json"})
            return

        task_text = (data.get("task") or "").strip()
        if not task_text:
            self._json(400, {"ok": False, "error": "task is empty"})
            return
        if len(task_text) > 4000:
            self._json(400, {"ok": False, "error": "task too long"})
            return

        item = create_task(task_text)
        t = threading.Thread(target=run_task, args=(item["id"],), daemon=True)
        t.start()
        self._json(
            200,
            {
                "ok": True,
                "status": "accepted",
                "taskId": item["id"],
                "checkUrl": f"/tasks/{item['id']}",
            },
        )


def main():
    print(f"[bridge] starting on http://{HOST}:{PORT}")
    print(f"[bridge] token protected: {bool(BRIDGE_TOKEN)}")
    print(f"[bridge] codex cli: {CODEX_CLI} {CODEX_FIXED_ARGS}".rstrip())
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
