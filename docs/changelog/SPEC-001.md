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
