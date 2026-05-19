**Added — バトル画面 UI + タップ操作 (Day 2 Phase 1C)**

- `index.html`: `#battleScreen` セクション追加 (= CPU 側 / battle-divider / プレイヤー 側 の 3 段構成 + hint バー)
- `css/battle.css` 新規。 縦並び portrait-first レイアウト + field-slot / hand-card / battle-side / battle-divider のスタイル
  - field-slot 状態: `field-slot--empty` / `field-slot--occupied` / `field-slot--sick` / `field-slot--highlight-target`
  - hand-card 状態: `hand-card--disabled` (= cost 不足) / `hand-card--selected`
- `js/battle/battle-ui.js` 新規。 state.battle を見て DOM 再描画 + UI state machine (= idle / summoning / attacking)
  - `renderBattle()` (= CPU info / hand-back / fields / divider / player info / player hand / hint)
  - `enterBattleScreen()` / `exitBattleScreen()` (= screen 遷移と pauseTime 連動)
  - イベント結線: hand-card タップ → highlight、 field-slot タップ → summon or attack、 End Turn → endTurn + runCpuTurn
- `js/battle/cpu-turn.js` 新規 (= Phase 1E AI に置換するための shim)。 `runCpuTurn()` で startTurn → 1.5s delay → endTurn → player auto-startTurn
  - CLAUDE.md の動詞 prefix にない `run*` を許容 (= Phase 1E `tickCpuTurn` / `applyCpuAction` 等にリプレース予定の暫定 shim)
- `js/main.js`: 「Press to Start」 を 「Start Battle」 に再用途化、 デモバトル初期化 (= 各ヒーロー 2 枚 × 3 種 = 6 枚デッキ) + 入場時に `enterBattleScreen` + player startTurn
- `data/i18n/ui.json`: バトル UI 用 15 キー追加 (= battle.turn.* / battle.phase.* / battle.btn.endTurn / battle.label.* / battle.hint.* / battle.gameOver.*)
- CPU AI / スプライトアニメ / 勝敗画面 / スキル発動は本 SPEC のスコープ外 (= Phase 1D 〜 Phase 1F / Phase 2)
