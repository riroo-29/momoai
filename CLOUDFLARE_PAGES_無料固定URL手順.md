# Cloudflare Pages 無料固定URL手順

## 目的
- 独自ドメインなし
- 無料
- 他デバイスでも同じURLで利用

Pages の `*.pages.dev` を使います。

## 0. 事前条件
- Cloudflareアカウント
- GitHubアカウント
- このフォルダを GitHub に push 済み

## 1. Cloudflare Pages プロジェクト作成
1. Cloudflare ダッシュボードを開く  
2. `Workers & Pages` -> `Create application`  
3. `Pages` -> `Connect to Git`  
4. 対象リポジトリを選択

## 2. Build設定
- Framework preset: `None`
- Build command: （空欄）
- Build output directory: `static`

## 3. 環境変数（Production）
- `GEMINI_API_KEY` = あなたのキー
- `GEMINI_MODEL` = `gemini-2.5-flash`（任意）
- `GEMINI_LIVE_MODEL` = `gemini-3.1-flash-live-preview`（任意）

設定後 `Save and Deploy`。

## 4. 完了後
固定URLが発行されます（例）:
- `https://momo-voice.pages.dev`

このURLを共有すれば、相手側でファイル復元は不要です。

## 5. 反映更新
コードを更新したら GitHub に push すると、Pages が自動で再デプロイします。

## 6. 補足
- APIキーはブラウザから到達できるフローを含むため、公開範囲は最小化してください。
- 将来本番運用する場合は、サーバー側トークン発行方式へ変更推奨です。

