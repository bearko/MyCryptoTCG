**Added — エンジンの契約（state の形・純粋関数・ファイルの持ち主） (Phase 1)**

- `js/engine/*` は DOM に触れない純粋関数。 乱数は引数の `rng`（mulberry32）。 `node --test tests/*.test.mjs` で検証
- state の形（map / lands / squads / forts / builds / log / notices / pending / ended）と Event・Notice・Pending の種類を固定
- モジュール: rng / hex / worldgen / pathfind / heroes / economy / orders / battle / ai / turn / season / souls / lines と `js/data.js` `js/state.js`
- `tools/build-data.mjs`: `bearko/mycryptoheroes` の JSON から `data/heroes.json`（6 パラメーター・部隊の種類・スキル・口調）と `data/enemies.json` を生成
- `data/messages.json`: メッセージ ID × 5 つの口調（bushi / noble / scholar / rogue / plain）のセリフ表と UI 文言
- `tools/sim.mjs`: 全ランドを CPU で 28 日回す無人シミュレーション（砦ポイント・占領・ヒーロー数・処理時間）
- 並列に作るためのファイルの持ち主の表（§5）
