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
