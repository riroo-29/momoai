@echo off
setlocal

REM Required:
REM   BRIDGE_TOKEN
REM Optional:
REM   BRIDGE_HOST (default 0.0.0.0)
REM   BRIDGE_PORT (default 8787)
REM   CODEX_CLI (default codex)
REM   CODEX_FIXED_ARGS (example: run --non-interactive)
REM   CODEX_TASK_PREFIX (example: この依頼を日本語で実行して: )

if "%BRIDGE_TOKEN%"=="" (
  echo [bridge] BRIDGE_TOKEN is empty. Set it before starting.
  exit /b 1
)

python "%~dp0windows_codex_bridge.py"

