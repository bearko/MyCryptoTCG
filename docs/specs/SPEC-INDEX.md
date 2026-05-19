# SPEC Index — mycryptotemplate

各 SPEC は `docs/specs/SPEC-NNN-<topic>.md` に置く。 ステータスは
`Draft / InReview / Approved / Implementing / Done / Cancelled` のいずれか。

派生プロジェクト (= このテンプレートを fork した側) は SPEC-001 として
プロジェクト固有の Charter を、 SPEC-002 以降にゲーム機能を起こしていく
構成を推奨。

下表は `node tools/build-spec-index.mjs` が `docs/specs/SPEC-NNN-*.md` の
YAML frontmatter から再生成する。 **`<!-- BEGIN AUTO-INDEX -->` ...
`<!-- END AUTO-INDEX -->` の間を直接編集しないこと**。

<!-- BEGIN AUTO-INDEX -->
| ID | タイトル | Status | Phase | 実装 PR |
|---|---|---|---|---|
| SPEC-001 | Bootstrap (= MyCryptoSurvivor SPEC-032/035/036/038 の知見を逆輸入) | Implementing | Phase 0 | claude/import-survivor-patterns-D9bql |
| SPEC-002 | Ranking Backend B (= Upstash Redis + Vercel Function) | Implementing | Phase 0 | docs/spec-002-ranking-backend-b-upstash |
| SPEC-003 | Ranking Backend デフォルトを B (Upstash+Vercel) に反転 | Implementing | Phase 0 | docs/spec-003-ranking-default-to-b |
| SPEC-100 | MyCryptoTCG 3 日リリース計画 (= Day 1〜Day 3 の Phase 配分) | Approved | Phase 0 | claude/import-kickoff-document-bQ6rP |
| SPEC-101 | プロジェクト Charter 書き換え + localStorage prefix `mctcg` 置換 (Day 1 Phase 0) | Implementing | Phase 0 | claude/import-kickoff-document-bQ6rP |
| SPEC-102 | カードデータ JSON + デッキ state + cards/deck モジュール (Day 1 Phase 1A) | Implementing | Phase 1A | claude/import-kickoff-document-bQ6rP |
| SPEC-103 | ターンシステム + 召喚 / 攻撃 / 勝敗判定ロジック (Day 1 Phase 1B) | Implementing | Phase 1B | claude/import-kickoff-document-bQ6rP |
| SPEC-104 | バトル画面 UI + 手札/場/マスター枠のタップ操作 (Day 2 Phase 1C) | Implementing | Phase 1C | claude/day2-battle-ui-and-sprites |
| SPEC-105 | スプライトアニメ (= idle/attack/hit/summon/die) + 3 体結線 (Day 2 Phase 1D) | Implementing | Phase 1D | claude/day2-battle-ui-and-sprites |
| SPEC-106 | CPU AI ルールベース (= 弱め貪欲) + アニメ結線 (Day 3 Phase 1E) | Implementing | Phase 1E | claude/day3-cpu-ai-and-gameover |
| SPEC-107 | 勝敗画面 + タイトル復帰 + ランキング送信 UI スタブ (Day 3 Phase 1F) | Implementing | Phase 1F | claude/day3-cpu-ai-and-gameover |
<!-- END AUTO-INDEX -->

## 命名規則

- ファイル名: `SPEC-NNN-<kebab-topic>.md` (= 連番 3 桁 + 簡潔な topic)
- 連番は **欠番にしない** (= Cancelled も削除せず履歴として残す)
- Phase ラベルは SPEC タイトルに含める (= 実装フェーズが追える)

## SPEC frontmatter

各 SPEC ファイルの冒頭に YAML frontmatter を置く。 `tools/build-spec-index.mjs`
と `tools/build-changelog.mjs` がこれを読んで一覧 / changelog を再生成する。

```yaml
---
id: SPEC-NNN
title: 短いタイトル (= INDEX 表に出る、 SPEC タイトル本文と一致させる)
status: Implementing       # Draft / Implementing / Done / Cancelled
pr: feat/spec-NNN-topic    # PR 採番後に "39" 等の数値に更新
phase: Phase 0 / Phase 1
kind: Added                # Added / Changed / Fixed / Removed (CHANGELOG 見出し)
---
```

## 参考

- `docs/process/SPEC_DRIVEN_DEVELOPMENT.md` 11 章 — fragment + 自動生成ワークフロー
- `docs/process/SPEC_DRIVEN_DEVELOPMENT.md` 4 章 — SPEC 本文のテンプレート
- `docs/charters/PROJECT_CHARTER.md` — プロジェクトのゴール (= SPEC を起こすときの判断軸)
