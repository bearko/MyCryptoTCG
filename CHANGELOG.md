# Changelog

このテンプレートの変更履歴。 [Keep a Changelog](https://keepachangelog.com/) 準拠。

## [Unreleased]

`<!-- BEGIN AUTO-UNRELEASED -->` 〜 `<!-- END AUTO-UNRELEASED -->` の間は
`node tools/build-changelog.mjs` が `docs/changelog/SPEC-NNN.md` (= 各 SPEC の
bullet fragment) + 対応 SPEC の YAML frontmatter から再生成する。
**この区間を直接編集しないこと** (= SPEC-001 で確立した運用)。

<!-- BEGIN AUTO-UNRELEASED -->
### Changed — SPEC-101 (= プロジェクト Charter 書き換え + localStorage prefix `mctcg` 置換 (Day 1 Phase 0))
**Changed — MyCryptoTCG プロジェクト Charter + localStorage prefix `mctcg` (Day 1 Phase 0)**

- `js/constants.js`: `LS_PREFIX = "<prefix>"` → `"mctcg"`、 `ASSET_BASE` を `https://raw.githubusercontent.com/bearko/mycryptotcg/main/assets/` に更新
- `docs/charters/PROJECT_CHARTER.md`: テンプレ placeholder を全削除し、 `MYCRYPTOTCG-KICKOFF.md` 1〜4 章から目的 / スコープ / 成功基準 / リリース計画を展開
- `index.html`: `<title>` / `og:title` / `og:description` を MyCryptoTCG 表記に
- `README.md`: 冒頭に MCT 概要を追加 (= テンプレ Day 1 Kickoff 本文は派生用の参考として残す)
- スプライト先行 3 体は MCH `heroId 1 / 2 / 3` で確定 (= 正式名は Phase 1A で MCH master DB から引用、 オリジナル名は付けない)
- 実装ロジック (= カードデータ / 戦闘 / UI / スプライト) は本 SPEC のスコープ外。 SPEC-102 以降で順次

### Added — SPEC-100 (= MyCryptoTCG 3 日リリース計画 (= Day 1〜Day 3 の Phase 配分))
**Added — 3 日リリース計画 (= Day 1〜Day 3 の Phase 配分)**

- `docs/specs/SPEC-100-three-day-release-plan.md` 新規。 `MYCRYPTOTCG-KICKOFF.md`
  5 章を Day 1〜3 の 7 SPEC (= 101〜107) に分解し、 各 Day の完了基準を表化
- Day 1 = Phase 0 (SPEC-101 charter/prefix) + Phase 1A (SPEC-102 card data) + Phase 1B (SPEC-103 turn logic)
- Day 2 = Phase 1C (SPEC-104 UI) + Phase 1D (SPEC-105 sprite anim 3 体)
- Day 3 = Phase 1E (SPEC-106 CPU AI) + Phase 1F (SPEC-107 win/lose + ranking stub)
- スプライト先行ヒーロー 3 体は MCH `heroId 1/2/3` を選定 (= 正式名は SPEC-102 で MCH master DB から引用)
- 本 SPEC は計画 meta のみ。 実装は配下 SPEC で個別 PR 化

### Changed — SPEC-003 (= Ranking Backend デフォルトを B (Upstash+Vercel) に反転)
**Changed — Ranking Backend デフォルトを B (Upstash+Vercel) に反転**

- `docs/process/RANKING_SETUP.md` の章順を入替: **Backend B (= 1〜7 章)** が
  既定として前に来る並びに変更。 旧 Backend A 章 (= 1〜10) は新 8〜17 章に
  ずれて 「代替、 GAS で完結したい場合」 セクションになる
- 0 章比較表の列順を **Backend B → Backend A** に入替、 行 「既定」 を
  「位置付け」 に改名し、 Backend B 列を 「テンプレート既定、 派生プロジェクトは
  まずこちらを検討」、 Backend A 列を 「代替、 GAS で完結したい場合」 と表現
- 0 章 「選び方の目安」 を default = B 前提で書き直し
  (= 「特別な理由がない限り Backend B」 / 「Vercel を使わない / GAS で完結したい
  / Spreadsheet を直接眺めたい / Vercel・Upstash アカウントを増やしたくない →
  Backend A」)
- 章間相互参照を新章番号に追従: 旧 「5 章参照」 → 新 「12 章参照」
  (= 新 10 章 URL 設定ビルトイン C 内)、 旧 「12.5 参照」 → 新 「2.5 参照」
  + 「詳細は 4 章」 へ
- **新 4 章 (= Backend B URL 設定)** を独立 3 パターン解説に展開: 旧の 「Backend A
  の 3 章を見ろ」 という 2 行委譲を、 default backend として A: localStorage /
  B: hash bootstrap / C: builtin の 3 パターンを `/api/ranking` 例で完結する形に
- Backend A 側 (= 新 10 章) の URL 設定章は従来通り GAS URL 例で解説を残す
  (= 各 backend のセクション内で完結)

**Added — `CLAUDE.md` 「ランキング機能の実装方針」 セクション**

- 「やってはいけないこと」 と 「作法 (= 暗黙の了解)」 の間に新セクションを挿入
- 派生プロジェクトでランキング機能を実装する場合、 **特別な指示が無い限り
  Backend B (Upstash + Vercel)** を選択することを規約化
- 着手時の振る舞いを 4 段階で明文化:
  1. AskUserQuestion で backend 確認 (= B (Recommended) / A / 後で の 3 択)
  2. Backend B 選択時の **6 step walkthrough** (= Vercel Storage で Upstash 作成 →
     環境変数注入確認 → `cp tools/vercel-ranking.js api/ranking.js` →
     git push → 動作確認 → URL 設定)
  3. Backend A 選択時は `RANKING_SETUP.md` 8〜17 章を参照しつつ GAS 手順を提示
  4. 「後で」 選択時は SPEC に 「ranking: 未決」 を記述、
     `_DEFAULT_API_URL_ENC = ""` のままで UI スタブのみ

**Changed — `README.md` Day 1 Kickoff プロンプト**

- 「ランキング (= GAS+Spreadsheet): YES / NO / 後で」 を
  「ランキング (= 既定 = Upstash + Vercel / 代替 = GAS):
  YES (default backend = Upstash) / YES (GAS で実装) / NO / 後で」 に変更
- 派生プロジェクトの 1 日目で backend 選択がブレないように default を可視化

**Changed — `js/ranking-client.js` のヘッダコメント**

- 旧コメント 「Google Apps Script ランキング API」 → 新 「ランキング API
  クライアント (= Backend A / B 共通)」 に変更 (= backend-agnostic を明示)
- `_DEFAULT_API_URL_ENC` の周辺 1 行コメントを **既定 (B) 例 + 代替 (A) 例 +
  テンプレ本体は空文字のまま** の多行コメントに刷新
- 既存 export (= `getRankingApiUrl` / `setRankingApiUrl` / `getPlayerName` /
  `setPlayerName` / `submitScore` / `fetchRanking`) のシグネチャは無変更
- `_DEFAULT_API_URL_ENC = ""` も据置 (= 派生で書き換える前提)

**Notes**

- Backend A (= GAS + Spreadsheet) の機能は **削除しない**。 `tools/gas-ranking.gs`
  も残す。 既存派生プロジェクトに breaking change なし
- 静的ホスティング / `package.json` 不要 / ビルドステップなし の不変条件を維持
  (= テンプレ自身に `api/ranking.js` を置かない方針も継続)
- 旧文書の `⚠` (= U+26A0、 装飾的な注意マーカー) は rewrite で削除
  (= CLAUDE.md 絵文字禁止ルールへの自発的準拠、 意味は文脈で伝わる)

### Added — SPEC-002 (= Ranking Backend B (= Upstash Redis + Vercel Function))
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
