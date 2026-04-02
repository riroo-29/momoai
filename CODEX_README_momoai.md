# CODEX_README_momoai

このファイルは、`ai_character_web` を別デバイスのCodexに読ませるための最小コンテキストです。
目的は「余分な素材を無視して、現在のサイト実装を正しく理解させること」です。

---

## 1. このサイトの現在仕様（要点）

- 音声会話モード専用（テキスト会話モードは削除済み）
- 画面はスマホ向け `9:16` のディスプレイ表示
- キャラ表示:
  - 待機時動画: `static/voice_idle.mp4`
  - 発話時動画: `static/voice_speaking.mp4`
- 会話中テキストの文字起こし表示はしない
- 左上の表示名は `もも`

---

## 2. Codexに最優先で読ませるファイル

1. `server.py`
2. `static/index.html`
3. `static/styles.css`
4. `static/app.js`
5. `.env.example`（設定テンプレート）
6. `restart_server_safe.sh` / `start_server.sh` / `stop_server.sh`

この6系統で、アプリの挙動はほぼ完全に把握できる。

---

## 3. ほぼ無視してよいファイル・フォルダ

下記は制作素材/過去試作なので、サイト動作理解には不要。

- `assets_psd/`
- `新規assets_psd/`
- `hair_parts_v1/` ～ `hair_parts_v5/`
- `*.psd`（ルートにあるPSD群）
- `前髪.png` `桃太郎*.png` などの単体素材

注意:
- `static/voice_idle.mp4` と `static/voice_speaking.mp4` は必須なので無視しない。

---

## 4. 実行方法（ローカル）

```bash
cd ai_character_web
./restart_server_safe.sh
```

ブラウザ:

```text
http://127.0.0.1:8000
```

---

## 5. 環境変数

`.env` の最低限:

```env
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.5-flash
GEMINI_LIVE_MODEL=gemini-3.1-flash-live-preview
HOST=127.0.0.1
PORT=8000
```

---

## 6. 変更時の注意

- キャラ動画差し替えは以下を上書き:
  - `static/voice_idle.mp4`
  - `static/voice_speaking.mp4`
- フロント変更後にブラウザキャッシュが残る場合は `index.html` の `?v=` を更新
- 「サイトが開かない」場合はまず `./restart_server_safe.sh`

---

## 7. 公開に関する補足

- 無料外部公開: `start_free_public_url.sh`（URLは固定でない）
- 固定URL公開: `start_public_tunnel.sh`（Cloudflareドメイン/Named Tunnel前提）

このプロジェクトを他デバイスで再現する場合、まずはローカル起動で確認してから公開手順に進むこと。

