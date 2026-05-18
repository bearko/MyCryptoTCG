---
id: SPEC-101
title: プロジェクト Charter 書き換え + localStorage prefix `mctcg` 置換 (Day 1 Phase 0)
status: Implementing
pr: claude/import-kickoff-document-bQ6rP
phase: Phase 0
kind: Changed
---

# SPEC-101 — プロジェクト Charter 書き換え + prefix `mctcg` 置換

## 1. 目的

`mycryptotemplate` から fork した直後のテンプレ状態を、 **MyCryptoTCG 固有の
基本設定** に書き換える。 この SPEC が Done になった時点で:

- `LS_PREFIX = "mctcg"` で localStorage キーが衝突なし
- `ASSET_BASE` が `bearko/mycryptotcg` の raw URL を指す
- `PROJECT_CHARTER.md` に MCT の目的 / スコープ / 勝利条件が記述
- `index.html` の `<title>` / meta が MyCryptoTCG 表記
- Console エラーなしで `index.html` が開く

実装ロジック (= カードバトル / スプライトアニメ等) は **本 SPEC のスコープ外**。
それらは SPEC-102 以降で扱う。

## 2. スコープ

### In Scope (= この SPEC で触る)

- `js/constants.js`
  - `LS_PREFIX` を `"<prefix>"` → `"mctcg"`
  - `ASSET_BASE` を `bearko/mycryptotcg/main/assets/` の raw URL に
  - `APP_VERSION` を `"0.1.0"` のまま据え置き (= Day 1 はまだ初版)
- `docs/charters/PROJECT_CHARTER.md`
  - `MYCRYPTOTCG-KICKOFF.md` の 1〜4 章を編集して charter として展開
  - 「(派生プロジェクトでここを書き換える)」 等のテンプレート文言を全削除
- `index.html`
  - `<title>` を `MyCryptoTCG` に
  - `og:title` / `og:description` / `meta description` を MCT 用に
  - ロゴ表示の placeholder テキストを `ProjectName` → `MyCryptoTCG`
- `README.md`
  - プロジェクトトップの 「テンプレート使い方」 セクションを 「MyCryptoTCG プロジェクト概要」 に書き換え
  - Day 1 Kickoff プロンプトのテンプレ部分は **削除しない** (= 派生プロジェクト の参考に残す)

### Out of Scope (= この SPEC では触らない)

- カードデータ / 戦闘ロジック / UI / スプライト / AI (= SPEC-102 以降)
- `docs/charters/DEVELOPMENT_CHARTER.md` / `DESIGN_CHARTER.md` (= テンプレ規約はそのまま継承)
- `docs/patterns/*.md` (= テンプレ由来の参考実装、 prefix リテラルはサンプルとして残す)
- `tools/build-spec-index.mjs` / `tools/build-changelog.mjs` (= 規約一致のまま使う)
- `assets/` ディレクトリの作成 (= SPEC-105 でスプライトを置く時に作る)

## 3. 実装ステップ

### 3-1. `js/constants.js`

```diff
-export const ASSET_BASE = "https://raw.githubusercontent.com/<user>/<asset-repo>/main/";
+export const ASSET_BASE = "https://raw.githubusercontent.com/bearko/mycryptotcg/main/assets/";

-export const LS_PREFIX = "<prefix>";   // ⚠ プロジェクトごとに置換
+export const LS_PREFIX = "mctcg";
```

`// ⚠` コメントは絵文字扱いではないが、 役割を終えたので削除する。

### 3-2. `docs/charters/PROJECT_CHARTER.md`

全文を MCT 用に書き換え。 構成:

1. プロジェクトの目的 (= MCH ヒーローで戦う 64×64 ピクセルアニメ × 高速カードバトル)
2. スコープ (= In/Out リストを kickoff 2 章 / 5 章から)
3. 成功基準 (= 1 バトルが 5〜10 ターン以内で終わる / Console エラー 0 / JP/EN 完全切替)
4. 制約 (= バニラ JS + 静的 host + MCH 経済圏遵守)
5. 主要なペルソナ (= MCH 既存プレイヤー + カードバトル DS 経験者)
6. リリース計画 (= Day 1〜3 + Phase 2 以降の表)
7. 関連ドキュメント

### 3-3. `index.html`

```diff
-<title>ProjectName</title>
+<title>MyCryptoTCG</title>

-<meta property="og:description" content="ProjectName — a vanilla JS game project from the mycryptotemplate base." />
+<meta property="og:description" content="MyCryptoTCG — MCH ヒーローで戦う、 64×64 ピクセルアニメ × 高速カードバトル" />
```

`og:title` も同様に置換。 ロゴ placeholder (= `<h1>ProjectName</h1>` のような箇所) は MCT 表記に。

### 3-4. `README.md`

- 1 行目を 「MyCryptoTCG — MCH ヒーローで戦う高速カードバトル」 に
- 「派生プロジェクトの始め方」 セクション (= テンプレ使い方) は残しつつ、 冒頭に MCT の概要を追加
- Day 1 Kickoff プロンプト本文は **削除しない** (= テンプレートとしての参照価値があるため)

## 4. テスト計画

- [ ] `index.html` をブラウザで開いて Console エラーなし
- [ ] `localStorage.setItem("mctcg.test", "1")` / `localStorage.getItem("mctcg.test")` が動く
- [ ] `<title>` タブに `MyCryptoTCG` が出る
- [ ] `js/constants.js` の `ASSET_BASE + "test.png"` が `https://raw.githubusercontent.com/bearko/mycryptotcg/main/assets/test.png` を返す
- [ ] `grep -rn "<prefix>" js/` が 0 件 (= js/ 内に未置換 placeholder が残っていない)
- [ ] `node tools/build-spec-index.mjs` を実行して SPEC-INDEX が SPEC-100/101 を含む形に再生成される

## 5. PR 構成

- ブランチ: `claude/import-kickoff-document-bQ6rP` (= 既存)
- コミット 1: SPEC-100 + SPEC-101 起こし + changelog fragment
- コミット 2: 実装 (= `js/constants.js` / `PROJECT_CHARTER.md` / `index.html` / `README.md`)
- コミット 3: SPEC-INDEX / CHANGELOG 再生成 (= `tools/build-*.mjs` 実行)

PR タイトル: `feat(spec-101): Phase 0 — MyCryptoTCG project charter + mctcg prefix`

## 6. 関連 SPEC

- SPEC-100: 3 日計画 (= 本 SPEC の上位)
- SPEC-102: カードデータと state (= 次フェーズ、 Phase 1A)
