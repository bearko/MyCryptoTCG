# Changelog

このテンプレートの変更履歴。 [Keep a Changelog](https://keepachangelog.com/) 準拠。

## [Unreleased]

`<!-- BEGIN AUTO-UNRELEASED -->` 〜 `<!-- END AUTO-UNRELEASED -->` の間は
`node tools/build-changelog.mjs` が `docs/changelog/SPEC-NNN.md` (= 各 SPEC の
bullet fragment) + 対応 SPEC の YAML frontmatter から再生成する。
**この区間を直接編集しないこと** (= SPEC-001 で確立した運用)。

<!-- BEGIN AUTO-UNRELEASED -->
### Added — SPEC-001 (= Bootstrap (= MyCryptoSurvivor SPEC-032/035/036/038 の知見を逆輸入))
**Added — テンプレート v0.2 bootstrap キット (= MyCryptoSurvivor 由来)**

- **`tools/build-spec-index.mjs`** 新規 (= 純 Node ESM、 依存なし)。 全 `docs/specs/SPEC-*.md` の YAML frontmatter から `SPEC-INDEX.md` の表を再生成
- **`tools/build-changelog.mjs`** 新規。 `docs/changelog/SPEC-NNN.md` (= bullet fragment) + SPEC frontmatter から `CHANGELOG.md` の `[Unreleased]` 区間を再生成
- `docs/specs/SPEC-INDEX.md` を新規作成 (= AUTO-INDEX マーカー入りの空テーブル + frontmatter スキーマ解説)
- `CHANGELOG.md` に `<!-- BEGIN AUTO-UNRELEASED -->` ... `<!-- END AUTO-UNRELEASED -->` マーカーを追加 (= [Unreleased] 区間)
- `docs/changelog/.gitkeep` + 本 fragment (`SPEC-001.md`) でディレクトリ構造を起ち上げ
- マーカー検出は `findLineAnchored()` で **行頭一致** (= fragment 本文中の literal mention を誤検出しない)

**Added — ランキング基盤 (= GAS Web App)**

- **`tools/gas-ranking.gs`** 新規。 `doPost` (= text/plain で受けて OPTIONS 回避) + `doGet` (= score DESC + regulation/version フィルタ) + `seedSampleData()` / `appendSampleData()` / `clearAllRankings()` の 3 関数
- `docs/process/RANKING_SETUP.md` 新規。 GAS デプロイ 5 分 + URL を 3 通り (= localStorage / hash bootstrap / `_DEFAULT_API_URL_ENC` ビルトイン) で配るパターン + 8 章としてサンプルデータ投入手順
- `js/ranking-client.js` の `getPlayerName()` を **未設定時 `"anonymous"`** を返すよう変更 (= SPEC-038)。 名前空欄の送信失敗を恒久回避
- `_DEFAULT_API_URL_ENC` は **空文字のまま** 据置 (= 派生で個別 URL を埋める前提、 サンプル URL の流用で全派生が同じ backend に書き込むのを防ぐ)

**Added — 活動レポート雛形 (= アイコン + 巨大スコア レイアウト)**

- `css/components.css` に `.report-*` クラス一式を追加 (= ヒーロー帯 56px 円形ポートレート / ステージカード / 38px エクステンションタイル + Lv バッジ / `clamp(2.6rem, 9vw, 4rem)` の巨大スコア / mobile breakpoint)
- 派閥カラーは `var(--seiryu, var(--accent))` の **fallback chain** で実装 (= 派生で `:root` に派閥色を定義すると帯が活き、 未定義なら accent に落ちる)
- `js/battle/activity-report.js` 新規 (= 雛形)。 DOM 結線 + `computeScore()` の基本式 + ranking submit + retry + 名前 prefill (= `getPlayerName()` で空欄に "anonymous" 補完)
- `data/i18n/ui.json` に `report.title` / `report.scoreLabel` / `gameover.*` キー一式を追加 (= JA/EN)

**Changed — Claude / SDD 運用ルール**

- `CLAUDE.md` 「作業の進め方」 に **PR で触る / 触らないファイル** 表を追加。 並列 PR の衝突を構造的に避けるため、 一覧ファイル (= SPEC-INDEX / CHANGELOG) は触らず SPEC ごとの自分専用ファイルだけを編集する流儀を明文化
- `docs/process/SPEC_DRIVEN_DEVELOPMENT.md` 11 章を新設 (= fragment ワークフロー + `build-*.mjs` 実行手順 + 並列 PR の衝突が構造的に消える理由)
<!-- END AUTO-UNRELEASED -->

### Added (= 手書き、 SPEC 未起票の小修正)
- `docs/lessons-learned/MCT-MCF-KPT.md` — MyCryptoTactics + MyCryptoFactory 2 作の振り返り (= テンプレート発端文書)
- `CHANGELOG.md` — このファイル

## [0.1.0] — 2026-05-09

### Added — テンプレート初版

#### Charters
- `docs/charters/PROJECT_CHARTER.md` — プロジェクト目的・スコープ・成功指標のテンプレ
- `docs/charters/DEVELOPMENT_CHARTER.md` — 14 セクションの開発規約 (Spec-First / Small PR / Defensive Coding ほか)
- `docs/charters/DESIGN_CHARTER.md` — Mobile First / カラーパレット / ボタン階層 / モーダル閉じ方

#### Patterns (8 docs)
- `01-environment-and-assets.md` — viewport / clamp / アセット CDN / JSON loader
- `02-screen-structure.md` — Title / Header / Stage / Modal / z-index 表
- `03-i18n-and-help.md` — i18n.js full code + applyDataI18n
- `04-time-and-modals.md` — pauseFlags counter + MCF Phase 1D-47 ownership fix
- `05-effects-audio-ui.md` — 紙吹雪 / sprite float / shake / BGM / SE
- `06-state-and-data.md` — 単一 state + 並列スロット accessor + 月次イベント dedup Set + seed RNG
- `07-ranking-integration.md` — Google Apps Script ランキング API + GAS V8 numeric separator 警告
- `08-dev-conventions.md` — 命名規則 / i18n キー / JSDoc / Conventional Commits

#### Process
- `docs/process/SPEC_DRIVEN_DEVELOPMENT.md` — Spec → Phase → PR 三段階ワークフロー
- `docs/process/GIT_WORKFLOW.md` — main / prod 戦略 + ブランチ命名 + リリース手順

#### Testing
- `docs/testing/TESTING_STRATEGY.md` — 3 層 (Unit / Sim / Manual QA)
- `docs/testing/TEST_CASES.md` — 起動 / レイアウト / i18n / 時間制御 / ランキング / 並列スロットの汎用チェックリスト

#### Setup
- `docs/setup/new-project.md` — 新規プロジェクト起ち上げ手順
- `docs/setup/google-apps-script.md` — GAS デプロイガイド (CORS preflight 回避 / numeric separator 警告含む)

#### Skeleton code
- `index.html` — Splash + Title + Header + Stage + Help overlay + Effect layers
- `js/main.js` — entry point (= initI18n / time loop / lang toggle / help overlay)
- `js/state.js` — 単一 state + pauseTime / resumeTime
- `js/constants.js` — ASSET_BASE / img / audioUrl / LS_PREFIX
- `js/i18n.js` — t / tpl / applyDataI18n / lang change listener
- `js/effects.js` — triggerConfetti / pushSpriteFloat / applyShake
- `js/audio.js` — startBgm / stopBgm / playSe (= throttle 付き)
- `js/data-loader.js` — loadJson cache helper
- `js/ranking-client.js` — getRankingApiUrl / submitScore / fetchRanking

#### CSS
- `css/base.css` — reset + CSS 変数
- `css/layout.css` — splash / title / header / stage
- `css/components.css` — buttons / cards / modals / notification
- `css/effects.css` — confetti / float / shake + reduced-motion
- `css/responsive.css` — mobile / tablet / pc + safe-area

#### Data
- `data/i18n/ui.json` — サンプル翻訳エントリ
- `data/sample-entities.json` — version 付きサンプルデータ

#### Tools
- `tools/sim/README.md` — sim ディレクトリの使い方
- `tools/sim/BALANCE_LOOP.md` — バランス調整自動 loop の収束条件と仕様

#### Claude Code 連携
- `CLAUDE.md` — 必読順 / 命名規則 / pause/resume invariants / デバッグ checklist
- `AGENTS.md` — Sub-agent 推奨カタログ + HITL escalation rules + Skills (= /loop, /schedule)
- `.claude/settings.json` — permission allowlist + ask list (= 破壊的操作)

#### Project meta
- `README.md` — テンプレート概要 + quickstart
- `.gitignore` — Node / IDE / OS / Vercel / Claude セッション
- `.github/PULL_REQUEST_TEMPLATE.md` — Summary / Why / Changes / Test plan

[Unreleased]: https://github.com/bearko/mycryptotemplate/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/bearko/mycryptotemplate/releases/tag/v0.1.0
