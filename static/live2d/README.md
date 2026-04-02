# Live2Dモデル配置（無料ワークフロー）

このフォルダに Live2D のエクスポートデータを置くと、アプリの `Live2D有効化` で読み込まれます。

## 1. 無料でモデルデータを作る

1. 立ち絵を作成（無料）
- `Krita` / `GIMP` などでパーツ分けPSDを作る
- 例: 前髪、後ろ髪、顔、目、口、体、腕、装飾をレイヤー分割

2. Live2D Cubism Editor Free を使う
- Free版でモデリング（デフォーマ、パラメータ、物理）
- 口パク: `ParamMouthOpenY`
- まばたき: `ParamEyeLOpen`, `ParamEyeROpen`
- 顔/体向き: `ParamAngleX/Y/Z`, `ParamBodyAngleX`

3. モデルを書き出し
- Cubism 4/5 の `.model3.json` 形式でエクスポート

## 2. このフォルダに置く

最低限、以下を配置:
- `model.model3.json`
- `*.moc3`
- `textures/*.png`
- `motions/*.motion3.json`（任意）
- `physics3.json`（任意）

## 3. アプリで有効化

1. サイトを開く
2. `Live2D有効化` を押す
3. 読み込み成功で Live2D が表示される

## 注意

- 現在の実装は `static/live2d/model.model3.json` を読み込み先にしています。
- ファイル名が違う場合は `static/app.js` の `Live2DModel.from("/live2d/model.model3.json")` を変更してください。
