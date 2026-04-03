# 2D AIキャラクター会話アプリ（焔丸）

画像付きの2Dキャラと会話できる、最小構成のWebアプリです。

## 1. 準備

1. Gemini APIキーを環境変数に設定

```bash
cd ai_character_web
cp .env.example .env
# .env を編集して GEMINI_API_KEY を設定
set -a
source .env
set +a
```

2. キャラ画像を配置（任意）

- `static/character.png` を置くと表示されます。
- 置かない場合はプレースホルダー画像が表示されます。

## 2. 起動

```bash
cd ai_character_web
set -a && source .env && set +a
python3 server.py
```

ブラウザで `http://127.0.0.1:8000` を開く。

## 3. 使い方

- 音声会話専用UI: `会話モード開始` を押してマイク許可
- 音声の種類: `Live音声選択` で変更

## 4. カスタマイズ

- キャラ性格（テキスト）: `server.py` の `SYSTEM_PROMPT`
- 音声会話時の性格: `static/app.js` の `config.systemInstruction`
- 見た目: `static/styles.css`
- 初期セリフ: `static/app.js`
- Live2Dデータ配置: `static/live2d/README.md`

## 5. 恒久公開URL（Cloudflare Tunnel）

1. Cloudflare Zero Trust で Named Tunnel を作成し、`tunnel token` を取得する  
2. `.env` に次を設定する

```bash
CLOUDFLARE_TUNNEL_TOKEN=xxxxxxxx
PUBLIC_BASE_URL=https://your-fixed-domain.example.com
```

3. ローカルサーバーを起動

```bash
cd ai_character_web
./restart_server_safe.sh
```

4. 恒久トンネルを起動

```bash
cd ai_character_web
./start_public_tunnel.sh
```

5. 停止するとき

```bash
cd ai_character_web
./stop_public_tunnel.sh
```

## 注意

- 既存IPキャラ名・デザインの流用は権利確認が必要です。オリジナル設定を推奨します。
- Gemini APIキーは [Google AI Studio](https://aistudio.google.com/apikey) で発行できます。
- 会話モードは Gemini Live API（WebSocket）を使います。
- 現在の実装は `GEMINI_API_KEY` をクライアントへ返すため、公開運用時はキー漏えい対策（Ephemeral Token/中継サーバー化）が必須です。

## 6. 無料の固定URL（Cloudflare Pages: `*.pages.dev`）

独自ドメインなしでも、Cloudflare Pages の無料サブドメインで固定URL化できます。

1. このフォルダを GitHub に push  
2. Cloudflare ダッシュボードで `Workers & Pages` -> `Create application` -> `Pages` -> `Connect to Git`  
3. リポジトリに `ai_character_web` を選択  
4. Build settings:
   - Framework preset: `None`
   - Build command: 空欄
   - Build output directory: `static`
5. Environment Variables（Production）を追加
   - `GEMINI_API_KEY` = あなたのAPIキー
   - `GEMINI_MODEL` = `gemini-2.5-flash`（任意）
   - `GEMINI_LIVE_MODEL` = `gemini-3.1-flash-live-preview`（任意）
6. `Save and Deploy`

固定URL例:
- `https://momo-voice.pages.dev`

この構成で `/api/chat` と `/api/live-config` は `functions/api/*.js` で動きます（Pythonサーバー不要）。
