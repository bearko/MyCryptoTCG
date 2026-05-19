**Added — 勝敗画面 + タイトル復帰 + ランキング送信 UI スタブ (Day 3 Phase 1F)**

- `index.html`: `#gameOverOverlay` modal を追加 (= helpOverlay と同じ z-index 階層、 半透明 backdrop + 中央パネル)
- `css/battle.css`: 勝敗オーバーレイ用クラス追加
  - `.game-over-overlay` / `.game-over-card` / `.game-over__title` (is-victory: garuda 緑 / is-defeat: ifrit 赤)
  - `.game-over__score` (= clamp(2.6rem, 9vw, 4rem) の巨大スコア)
  - `.game-over__stats` (= turn / 自軍 HP 残 / 敵軍 HP 残)
  - `.game-over__submit` (= 名前入力 + 送信ボタン + status エリア) / `.game-over__status` (is-ok / is-fail カラー)
- `js/battle/game-over.js` 新規:
  - `computeScore(battle, winner)` (= 純粋関数、 勝利: 2000 + HP×100 - turns×50、 敗北: turns×30 + 与ダメ×50 上限 800)
  - `showGameOverScreen(battle, winner)` (= DOM 更新 + pauseTime + overlay 表示)
  - `triggerSubmitRanking()` (= setPlayerName + submitScore + status 表示)
  - `triggerReturnToTitle()` (= state.battle = null + title へ復帰)
  - submit ボタンは getRankingApiUrl() が null なら disabled + 「未設定」 status を表示 (= Backend B 本実装は SPEC-013)
- `js/battle/battle-ui.js`: `finishBattle(winner)` から showGameOverScreen を呼ぶ
- `js/main.js`: Press to Start → 既存の `dismissTitle` で `triggerDemoBattle` が新規バトルを起こす (= 復帰後の再戦が動作)
- `data/i18n/ui.json`: 勝敗画面用 8 キー追加 (= gameover.title.victory / .defeat / .statMyHp / .statOppHp / .returnToTitle / .submit / .submitting / .submitOk / .submitFail / .noApi 等)
- Node 側 computeScore 5 ケース PASS (= 勝利フロア / 上限なし、 敗北 0〜800)
- ランキングバックエンド本実装は本 SPEC のスコープ外 (= SPEC-013 Backend B Upstash + Vercel で別途)
