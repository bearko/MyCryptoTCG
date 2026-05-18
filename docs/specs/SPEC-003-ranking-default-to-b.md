---
id: SPEC-003
title: Ranking Backend デフォルトを B (Upstash+Vercel) に反転
status: Implementing
pr: docs/spec-003-ranking-default-to-b
phase: Phase 0
kind: Changed
---

# SPEC-003 — Ranking Backend デフォルトを B (Upstash+Vercel) に反転

- **Status**: Implementing
- **Author**: bearko + Claude
- **Created**: 2026-05-10
- **Updated**: 2026-05-10

## 1. 背景 / 課題

SPEC-002 で **Backend B (= Upstash Redis + Vercel Function)** を初期搭載した
が、 当時の RANKING_SETUP.md は **Backend A (= GAS + Spreadsheet)** を default、
B を 「高速・本格運用向け」 の代替という並びで記載した。

実態として:

- 派生プロジェクトの大半は **Vercel に静的 host する** 構成 (= テンプレート
  自身がそうである)
- Vercel に既にいるなら、 同じ project 内で `/api/ranking` を立てる方が
  ドメイン管理もシークレット管理もシンプル
- Upstash Redis の Sorted Set はランキングそのもの (= ZADD / ZREVRANGE で済む)
  でレイテンシも数十ms、 同時書き込みもアトミック

→ **default を B に反転** し、 Backend A は 「Vercel を使わない場合の代替」
として残すのが派生プロジェクトの実装方針として自然。

加えて、 Claude セッションで派生プロジェクトに 「ランキング機能を追加して」 と
依頼が来た際、 **Backend B を default として 6 step の Vercel + Upstash 設定
walkthrough をユーザーに提示する** 振る舞いを CLAUDE.md に明文化することで、
派生での実装が再発明にならないようにする。

## 2. ゴール

- `docs/process/RANKING_SETUP.md` の章順を **Backend B (= 1〜7 章) → Backend A
  (= 8〜17 章)** に入替、 0 章比較表でも B = 既定、 A = 代替 と表現
- `CLAUDE.md` に 「**ランキング機能の実装方針**」 セクションを新設し、 派生
  プロジェクトでの:
  - 着手時 AskUserQuestion (= B 推奨 / A / 後で の 3 択)
  - Backend B 選択時の 6 step walkthrough (= Vercel Storage 作成 → 環境変数 →
    `cp tools/vercel-ranking.js api/ranking.js` → git push → 動作確認 → URL 設定)
  - Backend A 選択時の参照先 (= 8〜17 章)
  - 「後で」 選択時の扱い (= スタブのみ、 `_DEFAULT_API_URL_ENC = ""` 据置)
- `README.md` の Day 1 Kickoff プロンプト 「ランキング」 行で 4 択
  (= YES default / YES GAS / NO / 後で) に分岐
- `js/ranking-client.js` の `_DEFAULT_API_URL_ENC` 周辺コメントを **default = B
  例 + 代替 = A 例** の 2 例提示に書き換え (= 動作変更なし、 派生での書換を容易に)

## 3. 非ゴール

- **Backend A (= GAS) の機能削除はしない**。 `tools/gas-ranking.gs` も残す
- 既存テンプレ規約 (= 静的ホスティング / `package.json` 導入禁止 / ビルドステップなし)
  は維持
- `js/ranking-client.js` の **動作変更はしない** (= コメント刷新のみ、 export
  シグネチャ無変更)
- `tools/vercel-ranking.js` の機能変更なし (= SPEC-002 のまま)
- 既存派生プロジェクトの breaking change は無し (= ドキュメント方針変更のみ、
  既に GAS で組んでいる派生は影響なし)

## 4. ユーザー体験

### 4.1 シナリオ — 新規派生プロジェクトでランキング実装

1. ユーザー: 「新ゲームにランキング機能を追加したい」
2. Claude: AskUserQuestion で backend 確認:
   - A: Backend B (Upstash + Vercel) (Recommended)
   - B: Backend A (GAS + Spreadsheet)
   - C: 後で
3. ユーザー: A を選択 (= default 推奨)
4. Claude: Step 1 (Vercel Storage で Upstash 作成) を提示 + 完了確認
5. Claude: Step 2 (環境変数注入確認) を提示 + 完了確認
6. ... Step 6 まで walkthrough
7. ユーザーは MCH 経済圏に従ったゲームに `/api/ranking` 経由でスコア送信できる

### 4.2 シナリオ — GAS で完結したい派生

1. ユーザー: 「Vercel は使わない、 GAS で組みたい」
2. Claude: AskUserQuestion で backend = B (= Backend A) を確認
3. Claude: `RANKING_SETUP.md` の 8〜17 章 (= Backend A) を参照しつつ、
   Spreadsheet 作成 / Apps Script 貼付 / Web App デプロイ手順を提示

### 4.3 シナリオ — テンプレ自身は無変更

- `js/ranking-client.js` の `_DEFAULT_API_URL_ENC = ""` は据置
- `api/ranking.js` も追加しない (= 派生で `cp` してから有効化)
- → テンプレートをそのまま Vercel に deploy しても 500 を返す空 endpoint は
  露出しない

## 5. 技術設計

### 5.1 RANKING_SETUP.md の章順入替表

| 旧章 | 旧見出し | 新章 | 新見出し |
|---|---|---|---|
| 1 | 全体構成 (Backend A) | 8 | 全体構成 |
| 2 | デプロイ手順 (= 5 分) | 9 | デプロイ手順 (= 5 分) |
| 2.1〜2.4 | Spreadsheet 作る 〜 動作確認 | 9.1〜9.4 | (同) |
| 3 | ゲームに URL を設定 (Backend A) | 10 | ゲームに URL を設定 |
| 4 | シートのデータ構造 | 11 | シートのデータ構造 |
| 5 | 不正対策 (Backend A) | 12 | 不正対策 |
| 6 | 再デプロイ時の注意 | 13 | 再デプロイ時の注意 |
| 7 | ローカル開発時のテスト | 14 | ローカル開発時のテスト |
| 8 | テスト用サンプルデータ投入 (Backend A) | 15 | テスト用サンプルデータ投入 |
| 9 | 削除 / リセット | 16 | 削除 / リセット |
| 10 | 参考リンク (Backend A) | 17 | 参考リンク |
| 11 | Backend B 全体構成 | **1** | 全体構成 |
| 12 | Backend B デプロイ手順 (= 10 分) | **2** | デプロイ手順 (= 10 分) |
| 12.1〜12.5 | Upstash 作る 〜 URL 設定 | **2.1〜2.5** | (同) |
| 13 | Backend B のデータ構造 | **3** | データ構造 (= Redis Sorted Set) |
| 14 | ゲームに URL を設定 (Backend B) | **4** | ゲームに URL を設定 (= 詳細展開) |
| 15 | Backend B の不正対策 | **5** | 不正対策 |
| 16 | Backend B のテスト用サンプルデータ投入 | **6** | テスト用サンプルデータ投入 |
| 17 | 参考リンク (Backend B) | **7** | 参考リンク |

(= 文章本体は基本そのまま、 章番号と相互参照のみ追従)

### 5.2 0 章比較表の反転

- 列順を **Backend B → Backend A** に変更 (= 既定が左)
- 行 「**既定**」 を 「**位置付け**」 に改名し、 内容を:
  - Backend B 列: 「(= テンプレート既定、 派生プロジェクトはまずこちらを検討)」
  - Backend A 列: 「(= 代替、 GAS で完結したい場合)」
- 「選び方の目安」 を default = B 前提で書き直し

### 5.3 章間相互参照の更新

旧 → 新の参照書き換え:

| 旧参照 | 新参照 | 出現箇所 |
|---|---|---|
| 「5 章参照」 (= 不正対策、 Backend A 内) | 「12 章 (= Backend A の不正対策) 参照」 | 新 10 章 (URL 設定 ビルトイン C) |
| 「Backend A の 3 章と同じ 3 通り」 | (= 削除、 4 章を独立した 3 パターン解説に展開) | 新 4 章 (URL 設定 Backend B) |
| 「12.5 参照」 | 「2.5 参照」 + 「詳細は 4 章」 | 新 2.5 章 |

### 5.4 4 章 (= Backend B URL 設定) を独立 3 パターン解説に展開

旧の 「Backend A の 3 章を見ろ」 という委譲 (= 旧 14 章は 2 行) を、 default
backend として **自前で 3 パターン (A: localStorage / B: hash bootstrap /
C: builtin)** を `/api/ranking` 例で解説するよう独立。 Backend A 側の旧 3 章
(= 新 10 章) も従来通り GAS URL 例で解説を残す (= 重複だが各 backend の
セクション内で完結する方が読みやすい)。

### 5.5 CLAUDE.md 「ランキング機能の実装方針」 セクション挿入位置

「## やってはいけないこと」 と 「## 作法 (= 暗黙の了解)」 の間に挿入。 内容:

- 既定方針 (= Backend B) の宣言 + RANKING_SETUP.md 章番号への誘導
- 着手時の AskUserQuestion 3 択 + 推奨マーカー
- Backend B 選択時の **6 step walkthrough** (= Vercel Storage / 環境変数 /
  `cp` コマンド / git push / 動作確認 / URL 設定)
- Backend A 選択時の参照章 (= 新 8〜17 章)
- 後で選択時の扱い

### 5.6 README Day 1 Kickoff プロンプト変更

「ランキング (= GAS+Spreadsheet): YES / NO / 後で」 を:

```
ランキング (= 既定 = Upstash + Vercel / 代替 = GAS):
  YES (default backend = Upstash) / YES (GAS で実装) / NO / 後で
```

(= 派生プロジェクトの 1 日目で backend 選択がブレないように、 default を可視化)

### 5.7 js/ranking-client.js の冒頭コメント書き換え

旧 (= 1 行): `// ⚠ デプロイ後、 btoa("https://script.google.com/...") で base64 化して埋め込む`

新 (= 多行): backend-agnostic 説明 + 既定 (B) 例 + 代替 (A) 例 + テンプレ本体は空文字のまま。 動作変更なし、 import / export シグネチャ無変更。

(= 「⚠」 をシンボル U+26A0 として絵文字扱いされないか曖昧なため、 一括で削除。 装飾なし普通の文章に書き換え)

## 6. 実装フェーズ

| Phase | 内容 | PR |
|---|---|---|
| 0 | 本 SPEC + changelog fragment | docs/spec-003-ranking-default-to-b |
| 0 | RANKING_SETUP.md 章順入替 + 0 章比較表反転 + 4 章独立化 | 同上 |
| 0 | CLAUDE.md 「ランキング機能の実装方針」 セクション挿入 | 同上 |
| 0 | README Day 1 Kickoff プロンプト 「ランキング」 行更新 | 同上 |
| 0 | js/ranking-client.js コメント刷新 (= default = B / 代替 = A 例) | 同上 |

(= 全項目を 1 PR にまとめる。 ドキュメント中心の policy 切替なので)

## 7. テストケース

### ドキュメント

- [ ] `RANKING_SETUP.md` で目次が新章順 (= B 章群が前) で並ぶ
- [ ] 0 章比較表で **Backend B 列が左**、 「位置付け」 行で B = 既定 / A = 代替
- [ ] 章内の相互参照 (= 「N 章参照」) が全て新番号に追従している
  - 新 10 章 (= URL 設定 Backend A) ビルトイン C で 「12 章参照」 (= 旧 「5 章参照」)
  - 新 2.5 章 (= URL 設定 Backend B) で 「4 章」 への誘導
- [ ] Backend A の手順そのもの (= GAS デプロイ等) は文章本体が変わっていない
- [ ] CLAUDE.md の新セクション 「ランキング機能の実装方針」 が読める
- [ ] CLAUDE.md の 6 step walkthrough が再現可能
- [ ] README.md の Day 1 Kickoff プロンプトの 「ランキング」 行が default = B を示している

### コード

- [ ] `js/ranking-client.js` は依然として `node --check` 相当で OK
- [ ] `_DEFAULT_API_URL_ENC = ""` のままで、 export 関数のシグネチャは無変更
- [ ] 派生で `_DEFAULT_API_URL_ENC = "L2FwaS9yYW5raW5n"` を入れると
      `getRankingApiUrl()` が `"/api/ranking"` を返す (= 既存動作の維持確認)

### SPEC ワークフロー

- [ ] `docs/specs/SPEC-003-*.md` の frontmatter で `id: SPEC-003` /
      `status: Implementing` / `kind: Changed` が正しい
- [ ] `docs/changelog/SPEC-003.md` が **Changed** セクション中心
- [ ] `SPEC-INDEX.md` / `CHANGELOG.md` の AUTO 区間は **diff に出ない**
- [ ] merge 後の `node tools/build-spec-index.mjs` で SPEC-003 が表に追加される
      (= 動作確認は merge 後にメンテナーが実施)

## 8. リスク・懸念

- **既存派生プロジェクトの混乱**: 既に GAS で組んでいる派生に対して 「default
  が B になった」 と説明する場面が出る → 0 章比較表で 「Backend A は代替として
  完全サポート継続」 を明示することで影響を最小化
- **章番号変更による外部リンク切れ**: 他のドキュメント / SPEC が
  `RANKING_SETUP.md#5-不正対策` のように anchor で参照している場合、 リンクが
  ずれる → grep で検索した結果、 SPEC-001 / SPEC-002 / 既存 patterns には
  RANKING_SETUP.md への章 anchor 参照は無い (= ファイル全体への参照のみ)
- **Backend A の手順本体に変更がないか** が懸念点 → diff で文章本体の変更が
  無い (= 章番号と H1 セクション見出しのみ) ことを review で確認
- **Vercel/Upstash 環境変数注入の自動性に依存**: Marketplace 経由でない場合は
  手動注入が必要 → 2.1 章で 「(代替) Upstash 直接」 のセクションを残し、
  CLAUDE.md walkthrough Step 2 でも 「自動注入された環境変数を確認」 と表現
- **`⚠` 絵文字判定**: 旧文書に存在した `⚠` (= U+26A0) を rewrite で削除した
  (= CLAUDE.md 絵文字禁止ルールへの自発的準拠)。 意味は失われていない
  (= 文脈で 「注意」 が伝わる)

## 9. 参考

- `docs/process/RANKING_SETUP.md` — 本 SPEC で章順入替した手順書
- `docs/specs/SPEC-002-ranking-backend-b-upstash.md` — Backend B 初期搭載 SPEC
- `tools/vercel-ranking.js` — Backend B reference Function (= 本 SPEC では変更なし)
- `tools/gas-ranking.gs` — Backend A reference GAS (= 本 SPEC では変更なし)
- `js/ranking-client.js` — 両 backend 共通クライアント (= 本 SPEC ではコメント刷新のみ)
- `CLAUDE.md` 「ランキング機能の実装方針」 — 本 SPEC で新設
- `README.md` Day 1 Kickoff プロンプト — 本 SPEC で 「ランキング」 行更新
