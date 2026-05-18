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
