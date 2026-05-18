---
id: SPEC-001
title: Bootstrap (= MyCryptoSurvivor SPEC-032/035/036/038 の知見を逆輸入)
status: Implementing
pr: claude/import-survivor-patterns-D9bql
phase: Phase 0
kind: Added
---

# SPEC-001 — Bootstrap (= MyCryptoSurvivor の知見を逆輸入)

- **Status**: Implementing
- **Author**: bearko + Claude
- **Created**: 2026-05-10
- **Updated**: 2026-05-10

## 1. 背景 / 課題

mycryptotemplate v0.1.0 は MyCryptoTactics (= MCT) + MyCryptoFactory (= MCF)
2 作の知見をベースに作られたが、 その後 **MyCryptoSurvivor (= MCS)** で
4 つのパターンが新たに確立した。 派生プロジェクトが再発明しないように、
これらを **テンプレートに最初から組み込む** のが本 SPEC の狙い。

逆輸入対象 (= MCS の該当 SPEC):

| MCS SPEC | 内容 | 本テンプレでの位置 |
|---|---|---|
| SPEC-032 | Changelog Fragments + 自動生成 SPEC-INDEX | tools/build-*.mjs + marker 規約 |
| SPEC-035 | Ranking — GAS Backend + UI | tools/gas-ranking.gs + RANKING_SETUP.md |
| SPEC-036 | GAS Sample Data Seed (= 3 関数) | tools/gas-ranking.gs 末尾 |
| SPEC-038 | Activity Report Icon Layout + Anonymous Default Name | css/components.css `.report-*` + js/battle/activity-report.js + ranking-client.getPlayerName() |

## 2. ゴール

- 派生プロジェクトが fork 直後から下記を使える状態にする:
  - SPEC ごとの **changelog fragment + 自動生成 SPEC-INDEX** ワークフロー
  - **GAS Web App ベースのランキング** を 5 分でデプロイできるツール一式
  - 名前空欄でも 「anonymous」 で登録される **submit 保険**
  - **アイコン中心 + 巨大スコア** のリザルト雛形 (= CSS + JS skeleton)
- 既存テンプレート構造 (= プレーン ES Modules / 静的ホスティング / npm なし) を維持

## 3. 非ゴール

- 派生プロジェクトの **実装まで** はやらない (= activity-report.js は雛形のみ、
  ステージ / ヒーロー / extension 等の実データ接続は派生に委ねる)
- ranking UI (= `js/ranking-ui.js` の本格実装) は省略 (= MCS から後段で別途取込む余地)
- 既存 v0.1.0 の charter / patterns 群は触らない (= 別 SPEC で更新)

## 4. ユーザー体験

### 4.1 シナリオ — 派生プロジェクトの立ち上げ

1. `git clone mycryptotemplate <new-game>` で fork
2. `docs/process/RANKING_SETUP.md` を見ながら GAS を 5 分でデプロイ
3. 得た URL を `_DEFAULT_API_URL_ENC` に `btoa(URL)` で埋め込み
4. `js/battle/activity-report.js` の placeholder を実データで差し替え
5. SPEC-001 (= 派生プロジェクト自身の Charter) を `docs/specs/SPEC-001-<topic>.md` に書く
6. `docs/changelog/SPEC-001.md` に bullet で何をやったか書く
7. PR を出す → マージ → メンテナーが `node tools/build-*.mjs` を走らせて一覧再生成

### 4.2 シナリオ — 並列 PR

PR-A と PR-B が同時に進む状況:
- A は `docs/specs/SPEC-005-foo.md` と `docs/changelog/SPEC-005.md` を新規作成
- B は `docs/specs/SPEC-006-bar.md` と `docs/changelog/SPEC-006.md` を新規作成
- 双方とも `SPEC-INDEX.md` / `CHANGELOG.md` の自動生成区間は触らない
- → ファイル単位で衝突源が分離 (= 既存 v0.1.0 の運用問題が消える)

## 5. 技術設計

### 5.1 ディレクトリ追加

```
tools/
  build-spec-index.mjs        # NEW: SPEC frontmatter → SPEC-INDEX.md 表
  build-changelog.mjs         # NEW: fragment → CHANGELOG.md [Unreleased]
  gas-ranking.gs              # NEW: GAS Web App スクリプト全量

docs/
  specs/
    SPEC-INDEX.md             # NEW: AUTO-INDEX マーカー入り
    SPEC-001-bootstrap-from-survivor.md   # NEW: 本 SPEC
  changelog/                  # NEW: per-SPEC fragment 置き場
    .gitkeep
    SPEC-001.md
  process/
    RANKING_SETUP.md          # NEW

js/
  battle/
    activity-report.js        # NEW: リザルト画面の雛形
```

### 5.2 マーカー検出は行頭 anchor

`tools/build-*.mjs` は `<!-- BEGIN AUTO-* -->` ... `<!-- END AUTO-* -->` を
**行頭一致** で検出する (= `findLineAnchored()`)。 fragment 本文中に同じ文字列が
出てきても (= 例: コメントで marker を解説) 誤マッチしない。

### 5.3 SPEC frontmatter スキーマ

```yaml
---
id: SPEC-NNN
title: <短いタイトル>
status: Draft | Implementing | Done | Cancelled
pr: <数値 PR 番号 | branch 名>
phase: Phase X
kind: Added | Changed | Fixed | Removed
---
```

`build-spec-index.mjs` は全 6 フィールドを表に出し、 `build-changelog.mjs` は
`kind` を見出しに、 `status: Done` + `pr: <数値>` のときは ` — merged in #N` を
セクション見出しに付加。

### 5.4 GAS Web App データ構造

`ranking` シートのヘッダー (= 11 列):

```
timestamp | playerName | score | level | kills |
hero | faction | version | elapsedSec |
regulation | regulationMul
```

詳細は `docs/process/RANKING_SETUP.md` 4 章。

### 5.5 名前 anonymous フォールバック

```js
const DEFAULT_PLAYER_NAME = "anonymous";

export function getPlayerName() {
  try {
    const v = localStorage.getItem(LS_PLAYER_NAME);
    return (v && v.trim()) ? v : DEFAULT_PLAYER_NAME;
  } catch (e) { return DEFAULT_PLAYER_NAME; }
}
```

呼出側でも保険:

```js
if (input && !input.value) input.value = getPlayerName();
```

これで input 空でも送信ボタンを押せば `"anonymous"` で登録される。

### 5.6 リザルト DOM 構造 (= CSS 雛形)

```
#activityReportModal
  #activityReportTitle
  #activityReportHero          ← .report-hero__inner[data-faction]
  #activityReportStages        ← .report-stage[] (= flex column)
    .report-stage__head        — name + ⏱/💀/Lv
    .report-stage__exts        — .report-ext[] (= 38px icon + Lv バッジ)
  #activityReportTotals
    .report-meta-row           — レギュ / 時間 / kill の 1 行
    .report-score-big          — clamp(2.6rem, 9vw, 4rem) の巨大数字
    .report-score-label        — "SCORE" letter-spacing 0.3em
  #activityReportName          ← 空欄なら getPlayerName() で "anonymous"
  #activityReportNameLabel
  #activityReportSubmit
  #activityReportViewRanking   — (任意)
  #activityReportRetry
  #activityReportMsg
```

### 5.7 派閥カラー fallback

`.report-hero__inner[data-faction="SEIRYU"]` 等は
`var(--seiryu, var(--accent))` の **fallback chain** を使う。 派生で派閥カラー
変数を `:root` に定義すれば帯が活き、 未定義なら accent 色に落ちる。

## 6. 実装フェーズ

| Phase | 内容 | PR |
|---|---|---|
| 0 | 本 SPEC + changelog fragment + SPEC-INDEX 作成 | claude/import-survivor-patterns-D9bql |
| 0 | tools/build-*.mjs + tools/gas-ranking.gs + CHANGELOG marker | 同上 |
| 0 | docs/process/RANKING_SETUP.md + ranking-client.js anonymous fallback | 同上 |
| 0 | css/components.css `.report-*` + js/battle/activity-report.js skeleton + i18n | 同上 |
| 0 | CLAUDE.md 触る/触らない表 + SPEC_DRIVEN_DEVELOPMENT.md 11 章 | 同上 |

(= 全項目を 1 PR にまとめる。 派生プロジェクトの bootstrap キット相当なので)

## 7. テストケース

- [ ] `node tools/build-spec-index.mjs` が 1 エントリ (= 本 SPEC) で表を生成
- [ ] `node tools/build-changelog.mjs` が SPEC-001 fragment を `[Unreleased]` の AUTO 区間に挿入
- [ ] 2 回目の実行で 「no change」 が出る (= idempotent)
- [ ] `js/battle/activity-report.js` を `import` してもエラーが出ない (= 既存 i18n / state / ranking-client への依存だけ)
- [ ] `getPlayerName()` が localStorage 未設定で `"anonymous"` を返す
- [ ] `getPlayerName()` が空文字 / whitespace のみでも `"anonymous"` を返す
- [ ] css/components.css の `.report-score-big` の `clamp()` がモバイル幅でも壊れない

## 8. リスク・懸念

- **gas-ranking.gs に SPEC-037 由来の `regulation` / `regulationMul` カラム** が
  入っているが、 派生で別レギュレーションを使わない場合は無害 (= doGet 側で
  デフォルト NORMAL × 1.0 を返す)。 派生で 9 列に削っても良い (= breaking なし)
- **`_DEFAULT_API_URL_ENC` を空にしておく** ことが重要。 サンプル URL を残すと
  全派生がそこに POST してしまう (= 既に空文字を堅持)
- **`activity-report.js` の placeholder 部** は派生で差し替え必須。 雛形のまま
  動かしてもステージが空表示になる (= テンプレ動作確認 OK の最低限)

## 9. 参考

- https://github.com/bearko/mycryptosurvivor の SPEC-032 / 035 / 036 / 038
- `docs/process/SPEC_DRIVEN_DEVELOPMENT.md` 11 章 — fragment ワークフロー
- `docs/process/RANKING_SETUP.md` — GAS デプロイ + サンプルデータ
- `docs/patterns/07-ranking-integration.md` — v0.1.0 で既出の設計知見
