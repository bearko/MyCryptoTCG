**Added — Ranking Backend B (= Upstash Redis + Vercel Function)**

- **`tools/vercel-ranking.js`** 新規 (= 派生で `api/ranking.js` にコピーする
  reference Function)。 Upstash Redis を REST 経由で叩く `ZADD` / `ZREVRANGE` /
  `ZCARD` / `ZREMRANGEBYRANK` / `SCAN MATCH` を **純 Node stdlib `fetch`** で実装
  (= `package.json` 不要、 テンプレートの 「ビルドステップなし」 不変条件を維持)
- POST `/api/ranking` で `MAX_SCORE = 1_000_000` 上限、 30 文字 / 60 文字での
  ペイロード切詰め、 nonce 付与による同一スコア重複対応、 `RANKING_CAP = 1000`
  超過時の末尾切り捨て (= ZREMRANGEBYRANK) を実装
- GET `/api/ranking?limit=20&version=...&regulation=...` で version 指定時は
  ZREVRANGE 1 発、 未指定なら `SCAN MATCH ranking:*:<regulation>` で横断取得
  + メモリ上で score 降順マージ
- CORS は `Access-Control-Allow-Origin: *` を常時付与 (= クロスオリジン deploy 対応)、
  OPTIONS preflight も handler で 204 で受ける (= text/plain なので preflight は
  通常出ないが派生での JSON 化に備える保険)
- rate limit (= INCR + EXPIRE) と admin endpoint (= DEL) はファイル末尾にコメント雛形

**Changed — `docs/process/RANKING_SETUP.md` (= Backend A / B 統合ガイド)**

- タイトルを 「Ranking Backend Setup (Google Apps Script)」 → 「Ranking Backend Setup」
  に変更 (= 単一バックエンド前提から複数バックエンド前提へ)
- **0 章** 新設: Backend A vs B の比較表 (= デプロイ先 / レイテンシ / 無料枠 /
  選び方の目安) で派生プロジェクトが最初に読む選択指針を提示
- 既存 1〜10 章を **H1 「Backend A — Google Apps Script + Spreadsheet (= default)」**
  の配下に括り直し (= 文章本体は変更なし、 セクション見出しのみ追加)
- **11〜17 章** 新設: 「Backend B — Upstash Redis + Vercel Function」 として
  - 11 全体構成 (= ASCII 図 + 依存ゼロ宣言)
  - 12 デプロイ手順 (= Upstash 作成 / `cp tools/vercel-ranking.js api/ranking.js` /
    git push / `?limit=5` 動作確認 / `/api/ranking` を URL 設定)
  - 13 データ構造 (= `ranking:<version>:<regulation>` Sorted Set + JSON member + nonce)
  - 14 ゲームに URL を設定 (= 同一オリジン推奨 + `btoa("/api/ranking")` 例)
  - 15 不正対策 (= score 上限 / rate limit / HMAC で個人プロジェクトの落としどころ)
  - 16 テスト用サンプルデータ投入 (= 12 件 curl ループ + Upstash console での `DEL`)
  - 17 Backend B 参考リンク (= Vercel Functions / Upstash REST / Sorted Sets)

**Notes**

- **`api/ranking.js` をテンプレート repo には置かない**: template 自体を Vercel に
  deploy すると空 endpoint (= 500) を露出してしまうため、 派生で **明示的に
  `tools/vercel-ranking.js` を `api/ranking.js` にコピー** することで初めて有効化
- **`js/ranking-client.js` は変更なし**: 両 backend が同じ API 契約 (= POST/GET +
  `{ok, ranking, error}`) を満たすので、 URL を切替えるだけで両方で動く
- **`@upstash/redis` SDK は使わない**: 使うと `package.json` が必要になり、
  「ビルドステップなし」 不変条件 (= `CLAUDE.md` 技術スタック節) を破るため
