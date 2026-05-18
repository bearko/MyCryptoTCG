---
id: SPEC-002
title: Ranking Backend B (= Upstash Redis + Vercel Function)
status: Implementing
pr: docs/spec-002-ranking-backend-b-upstash
phase: Phase 0
kind: Added
---

# SPEC-002 — Ranking Backend B (= Upstash Redis + Vercel Function)

- **Status**: Implementing
- **Author**: bearko + Claude
- **Created**: 2026-05-10
- **Updated**: 2026-05-10

## 1. 背景 / 課題

SPEC-001 (= MyCryptoSurvivor の知見逆輸入) で **Backend A** として GAS +
Spreadsheet 構成を取り込んだが、 派生プロジェクトによっては:

- Vercel に既にホストしていて **同じ project 内** で API を完結させたい
- レイテンシを **インメモリ Redis** で詰めたい (= GAS の warm-up を避けたい)
- 同時書き込みの整合性が欲しい (= Spreadsheet write contention を避けたい)
- 個人ランキングを Spreadsheet で眺める手軽さは不要

というケースがある。 今までは派生で 0 から組み立てるしかなかったが、
template に **第 2 のバックエンド** を初期搭載すれば、 fork 直後に
切替可能になる。

## 2. ゴール

- 派生プロジェクトが **Backend A / B のどちらでも 5〜10 分でデプロイ** できる状態
- クライアント (`js/ranking-client.js`) は **変更なし** で両 backend を扱える
  (= 同じ API 契約: POST/GET + `{ok, ranking, error}`)
- Backend B が **テンプレートの「ビルドステップなし」 不変条件を破らない**
  - `package.json` 導入なし (= `@upstash/redis` SDK 不使用、 純 `fetch`)
  - フロントは静的 host のまま
  - 派生で **`api/ranking.js` をコピーした時だけ** Vercel が function を deploy
- ドキュメントを **1 つの `RANKING_SETUP.md`** に統合 (= 別ファイルに分けない)

## 3. 非ゴール

- 派生プロジェクトでの **実 deploy** はやらない (= テンプレ側はファイル整備まで)
- Vercel 以外の hosting (= Cloudflare Workers / Netlify Functions / AWS Lambda)
  への移植は対象外 (= 同じ API 契約なので雛形を参考に派生で起こす)
- 既存 Backend A の機能変更なし (= サンプルデータ seed 関数等は据置)
- ランキング UI (`js/ranking-ui.js`) の追加は SPEC-001 から引き続き省略

## 4. ユーザー体験

### 4.1 シナリオ — Backend B でランキングを動かす

1. 派生プロジェクトを Vercel に連携 (= 既に静的サイト deploy が動いている前提)
2. Vercel ダッシュボード → **Storage → Create Database → Upstash for Redis**
   (= Marketplace 経由なら環境変数が自動注入)
3. `cp tools/vercel-ranking.js api/ranking.js` でリファレンスを repo に追加
4. `git push` → Vercel が自動 deploy
5. `https://<project>.vercel.app/api/ranking?limit=5` で `{"ok":true,"ranking":[]}` 確認
6. クライアントの API URL を `"/api/ranking"` に設定 (= localStorage か `_DEFAULT_API_URL_ENC`)
7. ゲームから submit して反映を確認

### 4.2 シナリオ — Backend A から B に乗り換え

1. 上記 4.1 を実施
2. クライアントの API URL だけ差し替え (= GAS URL → `/api/ranking`)
3. Spreadsheet のデータは捨てるか、 一括 import スクリプトを書く (= 派生で SPEC を起こす)

## 5. 技術設計

### 5.1 ディレクトリ追加

```
tools/
  vercel-ranking.js          # NEW: 派生で api/ranking.js にコピーするリファレンス

docs/
  specs/
    SPEC-002-ranking-backend-b-upstash.md    # NEW: 本 SPEC
  changelog/
    SPEC-002.md                              # NEW: changelog fragment
  process/
    RANKING_SETUP.md                         # CHANGED: タイトル + 0章 + 11-17章
```

### 5.2 RANKING_SETUP.md の構造変更

- タイトル: 「Ranking Backend Setup (Google Apps Script)」 → 「Ranking Backend Setup」
- **0 章** 追加: バックエンドの選択肢比較表 (Backend A vs B)
- 1〜10 章 (= 既存 GAS 内容) を **「Backend A — Google Apps Script + Spreadsheet」**
  という H1 セクションの下に括り直し (= 文章本体は触らない)
- **11〜17 章** 新規: 「Backend B — Upstash Redis + Vercel Function」 として
  - 11 全体構成
  - 12 デプロイ手順 (= Upstash 作成 / api/ranking.js 配置 / Vercel 反映 / 動作確認 / URL 設定)
  - 13 データ構造 (= Sorted Set 設計 / nonce / key 戦略)
  - 14 ゲームに URL を設定 (= 同一オリジン推奨)
  - 15 不正対策 (= score 上限 / rate limit / HMAC)
  - 16 テスト用サンプルデータ投入 (= curl ループ例)
  - 17 参考リンク

### 5.3 Upstash REST + 純 fetch

`@upstash/redis` SDK を使うと `package.json` が必要になり、 テンプレートの
「ビルドステップなし」 不変条件を破る。 代わりに **Upstash の REST endpoint
を `fetch` で直接叩く**:

```js
async function redisCmd(...args) {
  const res = await fetch(REDIS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  return (await res.json()).result;
}
```

これで `package.json` 不要のまま `ZADD` / `ZREVRANGE` / `ZCARD` /
`ZREMRANGEBYRANK` / `SCAN` を呼べる。

### 5.4 Redis データ構造

| Redis key | 型 | 内容 |
|---|---|---|
| `ranking:<version>:<regulation>` | Sorted Set | score 順のメンバー集合 |

- **score** = Sorted Set の数値スコア (= 整数)
- **member** = エントリ全体を JSON 化した文字列 (= 一意性のために `nonce` 同梱)
- GET 時は member を JSON.parse し、 `nonce` を削除して返す
- 上位 1000 件超過時は ZREMRANGEBYRANK で末尾切り捨て

`version` / `regulation` で物理 key を分離するので、 「同 version の同 regulation」
を返すクエリが ZREVRANGE 1 発で済む。 全 version 横断は SCAN MATCH +
メモリマージ。

### 5.5 CORS と Content-Type

- POST は `text/plain;charset=utf-8` で受ける (= 既存クライアントとの互換)
- レスポンスに `Access-Control-Allow-Origin: *` を常時付与 (= クロスオリジン対応)
- OPTIONS preflight も handler で受けて 204 を返す (= text/plain なので
  本来 preflight は出ないが、 別オリジン JSON POST に切替えた派生で動くように保険)

### 5.6 テンプレート側に `api/ranking.js` を置かない理由

template 自体を Vercel に deploy すると `api/ranking.js` が空 endpoint
(= 500 を返す) として露出してしまう。 派生プロジェクトが **明示的にコピー**
することで初めて有効化される設計にする (= reference は `tools/vercel-ranking.js`)。

## 6. 実装フェーズ

| Phase | 内容 | PR |
|---|---|---|
| 0 | 本 SPEC + changelog fragment | docs/spec-002-ranking-backend-b-upstash |
| 0 | RANKING_SETUP.md タイトル変更 + 0 章追加 + Backend A 括り直し | 同上 |
| 0 | RANKING_SETUP.md 11〜17 章 (Backend B) 追記 | 同上 |
| 0 | tools/vercel-ranking.js 新規 (= reference Function) | 同上 |

(= 全項目を 1 PR にまとめる。 ドキュメント + 1 リファレンスファイルなので)

## 7. テストケース

- [ ] `docs/process/RANKING_SETUP.md` の 0 章で Backend A / B の比較表が読める
- [ ] 既存 Backend A の 1〜10 章は文章本体が変わっていない (= diff で確認)
- [ ] 11〜17 章で Backend B のデプロイ手順が独立して通読できる
- [ ] `tools/vercel-ranking.js` を `api/ranking.js` にコピー + Upstash 環境変数
      設定 + Vercel deploy で `/api/ranking?limit=5` が `{"ok":true,"ranking":[]}` を返す
- [ ] POST → GET の連続呼び出しでスコアが反映される
- [ ] `score > 1_000_000` で 400 が返る (= 不正対策動作確認)
- [ ] クライアントの `js/ranking-client.js` を **変更せず** に `/api/ranking` で submit / fetch できる
- [ ] `node tools/build-spec-index.mjs` で SPEC-002 が表に出る (= merge 後の自動再生成パス)

## 8. リスク・懸念

- **`api/ranking.js` を派生でコピーし忘れる** と Backend B が動かない (= 動作確認手順に明記)
- **Upstash 無料枠超過** (= 10k commands/day 程度) — score 投稿が多すぎる派生では
  Vercel ダッシュボード or Upstash console で監視が必要
- **同一スコア同一プレイヤーの連続投稿** で nonce が衝突する可能性
  (= 確率的にほぼ 0、 8 文字の base36 ランダム)
- **環境変数未設定で deploy** すると POST が `UPSTASH env vars not set` で 500 を返す
  (= 動作確認 12.4 で早期に気付く)
- **`@upstash/redis` SDK を使いたい誘惑** — 使うと package.json が要るので
  純 `fetch` で済ますことを SPEC として釘付けする

## 9. 参考

- `docs/process/RANKING_SETUP.md` — 本 SPEC で更新した手順書 (= Backend A + B 統合)
- `tools/vercel-ranking.js` — 本 SPEC で追加した reference Function
- `tools/gas-ranking.gs` — Backend A の reference GAS スクリプト (= SPEC-001 で追加済)
- `js/ranking-client.js` — 両 backend 共通クライアント (= 本 SPEC では変更なし)
- Upstash REST API: <https://upstash.com/docs/redis/features/restapi>
- Vercel Functions: <https://vercel.com/docs/functions>
- Redis Sorted Sets: <https://redis.io/docs/data-types/sorted-sets/>
