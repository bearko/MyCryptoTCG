---
id: SPEC-107
title: 勝敗画面 + タイトル復帰 + ランキング送信 UI スタブ (Day 3 Phase 1F)
status: Implementing
pr: claude/day3-cpu-ai-and-gameover
phase: Phase 1F
kind: Added
---

# SPEC-107 — 勝敗画面 + タイトル復帰 + ランキング送信 UI スタブ

## 1. 目的

Day 2 SPEC-104 では勝敗確定時に divider に簡易 hint を表示するだけだった。
本 SPEC で **スコア計算 + 勝敗オーバーレイ + ランキング送信フォーム + タイトル
復帰** を実装し、 1 バトルが 完全に閉じたループ (= title → battle → game over →
title) として遊べる状態にする。

## 2. スコープ

### In Scope

- `index.html`: `#gameOverOverlay` modal を新規追加 (= helpOverlay と同じ z-index 階層)
- `css/battle.css`: 勝敗オーバーレイ用クラス追加 (= 全面背景 + 中央パネル + 名前入力 + ボタン群)
- `js/battle/game-over.js` 新規:
  - `computeScore(battle, winner)` (= 純粋関数、 turn / HP / 勝敗から score を算出)
  - `showGameOverScreen(battle, winner)` (= スコア計算 → DOM 更新 → overlay 表示 → pauseTime)
  - `closeGameOverScreen()` (= overlay 非表示 + resumeTime)
  - `triggerSubmitRanking()` (= name 取得 → submitScore → 結果表示)
  - `triggerReturnToTitle()` (= state.battle = null + battle screen 非表示 + title 表示)
- `js/battle/battle-ui.js` 改修: `finishBattle(winner)` で `showGameOverScreen` を呼ぶ
- `js/main.js`: タイトル復帰時の初期化整理 (= 再度 「バトル開始」 で新規バトルが開ける)
- `data/i18n/ui.json`: 勝敗画面用 i18n キー追加

### Out of Scope

- ランキングバックエンド本実装 (= SPEC-013 Backend B、 本 SPEC は UI スタブのみ。 API URL 未設定なら 「未設定」 表示で submit はグレーアウト)
- 詳細スコア (= MCH レアリティボーナス / コンボ等は Phase 2)
- リプレイ機能 (= スコープ外)
- 統計 / 累計成績 (= Phase 2)

## 3. スコア式

```js
function computeScore(battle, winner) {
  const isPlayerWin = winner === "player";
  const turns = battle.turnNumber;
  const myHpRemain = battle.player.masterHp;
  const oppHpRemain = battle.cpu.masterHp;

  if (isPlayerWin) {
    // 勝利: 早く高 HP で勝つほど高得点
    //   base 2000 + (player HP 残量 × 100) - (turns × 50)
    //   フロア 100、 上限 なし
    return Math.max(100, 2000 + myHpRemain * 100 - turns * 50);
  } else {
    // 敗北: 長く粘るほど高得点 (= 慰めスコア)
    //   turns × 30 + (cpu HP を削った量 × 50)
    //   フロア 0、 上限 800 (= 勝利スコアと明確に差をつける)
    const damageDealt = Math.max(0, 10 - oppHpRemain);
    return Math.min(800, turns * 30 + damageDealt * 50);
  }
}
```

## 4. 勝敗画面の構成

```
┌─────────────────────────────┐
│ (semi-transparent backdrop)  │
│                              │
│  ┌─────────────────────┐    │
│  │   Victory! / Defeat │    │  ← 大見出し
│  │                     │    │
│  │       SCORE         │    │
│  │       2350          │    │  ← 巨大スコア
│  │                     │    │
│  │  ターン: 7          │    │  ← stats grid
│  │  自軍 HP 残: 4      │    │
│  │  敵軍 HP 残: 0      │    │
│  │                     │    │
│  │  [プレイヤー名 □]   │    │  ← ranking submit
│  │  [ランキング送信]   │    │
│  │  (ステータス表示)    │    │
│  │                     │    │
│  │  [タイトルに戻る]   │    │
│  └─────────────────────┘    │
│                              │
└─────────────────────────────┘
```

### 4-1. HTML 骨格

```html
<div id="gameOverOverlay" class="game-over-overlay hidden">
  <div class="game-over-card">
    <h2 id="gameOverTitle" class="game-over__title"></h2>
    <div class="game-over__score-label" data-i18n="report.scoreLabel">SCORE</div>
    <div id="gameOverScore" class="game-over__score">0</div>
    <ul class="game-over__stats">
      <li><span data-i18n="battle.label.turn">ターン</span> <span id="goStatTurns"></span></li>
      <li><span data-i18n="gameover.statMyHp">自軍 HP 残</span> <span id="goStatMyHp"></span></li>
      <li><span data-i18n="gameover.statOppHp">敵軍 HP 残</span> <span id="goStatOppHp"></span></li>
    </ul>
    <div class="game-over__submit">
      <label data-i18n="gameover.namelabel">プレイヤー名</label>
      <input type="text" id="goNameInput" maxlength="30" />
      <button id="btnSubmitRanking" class="btn"></button>
      <div id="goSubmitStatus" class="game-over__status"></div>
    </div>
    <button id="btnReturnToTitle" class="btn btn--ghost"></button>
  </div>
</div>
```

### 4-2. 動作

1. **オープン**: `finishBattle` → `showGameOverScreen(battle, winner)`
   - `computeScore` でスコア算出
   - DOM 各要素を更新 (= title / score / stats)
   - `getRankingApiUrl()` が null なら submit ボタンを disabled + 「未設定」 状態
   - 名前入力に `getPlayerName()` の値を prefill
   - `pauseTime()` + overlay 表示
2. **ランキング送信**: ボタンクリック →
   - 名前を `setPlayerName` で保存
   - `submitScore({playerName, score, version, regulation: "mvp-day3"})` を呼ぶ
   - 結果を status エリアに表示 (= 送信中… → OK / Fail)
3. **タイトル復帰**: ボタンクリック →
   - overlay 非表示 + `resumeTime`
   - battle screen 非表示
   - `state.battle = null`
   - title screen 表示 + Press to Start ボタンが再び有効

## 5. main.js / title flow の整理

```js
function returnToTitle() {
  // game-over overlay は既に閉じている前提で
  $("#battleScreen")?.classList.add("hidden");
  $("#app")?.classList.add("hidden");
  $("#titleScreen")?.classList.remove("hidden");
  // battle state クリア
  state.battle = null;
}
```

タイトル復帰後、 ユーザが Press to Start を押すと `dismissTitle` → `triggerDemoBattle`
が再実行され、 新規バトルが始まる。 listeners は `_listenersBound` で重複登録されない。

## 6. CSS

`css/battle.css` 末尾に追加 (= helpOverlay と類似のパターン):

```css
.game-over-overlay {
  position: fixed; inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.7);
  z-index: 100;
  padding: 1rem;
}
.game-over-card {
  width: 100%;
  max-width: 380px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
  padding: 1.5rem;
  background: var(--panel);
  border: 1px solid var(--accent);
  border-radius: 0.8rem;
  box-shadow: var(--shadow-lg);
}
.game-over__title {
  margin: 0;
  font-size: 1.6rem;
  font-weight: 900;
  letter-spacing: 0.06em;
}
.game-over__title.is-victory { color: var(--garuda); }
.game-over__title.is-defeat  { color: var(--ifrit); }
.game-over__score-label {
  font-size: 0.85rem; color: var(--muted);
  letter-spacing: 0.1em;
}
.game-over__score {
  font-size: clamp(2.6rem, 9vw, 4rem);
  font-weight: 900;
  color: var(--accent);
  line-height: 1;
}
.game-over__stats {
  list-style: none; padding: 0; margin: 0;
  display: flex; flex-direction: column; gap: 0.3rem;
  width: 100%;
  font-size: 0.85rem; color: var(--muted);
}
.game-over__stats li {
  display: flex; justify-content: space-between;
  padding: 0.2rem 0.4rem;
}
.game-over__submit {
  width: 100%;
  display: flex; flex-direction: column; gap: 0.4rem;
}
.game-over__submit label { font-size: 0.8rem; color: var(--muted); }
.game-over__submit input {
  appearance: none;
  background: var(--panel-2);
  color: var(--text);
  border: 1.5px solid var(--border);
  border-radius: 0.3rem;
  padding: 0.4rem 0.6rem;
  font: inherit;
}
.game-over__status { min-height: 1.2rem; font-size: 0.8rem; color: var(--muted); }
.game-over__status.is-ok   { color: var(--garuda); }
.game-over__status.is-fail { color: var(--ifrit); }
```

## 7. テスト計画

### 7-1. Node 側 (= computeScore のみ)

- [ ] `computeScore(battle, "player")` で turns=1, myHp=10 → 2000 + 1000 - 50 = 2950
- [ ] `computeScore(battle, "player")` で turns=10, myHp=1 → 2000 + 100 - 500 = 1600
- [ ] `computeScore(battle, "player")` で turns=50, myHp=0 → max(100, 2000 + 0 - 2500) = 100 (= フロア)
- [ ] `computeScore(battle, "cpu")` で turns=8, oppHp=3 → 8*30 + 7*50 = 590
- [ ] `computeScore(battle, "cpu")` で turns=20, oppHp=0 → min(800, 20*30 + 10*50) = 800 (= 上限)

### 7-2. ブラウザ手動テスト

- [ ] バトル決着で勝敗オーバーレイが pop up
- [ ] 勝利時は緑タイトル + Victory!、 敗北時は赤タイトル + Defeat...
- [ ] スコア / ターン / HP 残量 が正しく表示
- [ ] 名前入力に既存 `getPlayerName()` が prefill (= 初回は "anonymous")
- [ ] ranking API URL 未設定状態でランキング送信ボタンが disabled + 「未設定」 status
- [ ] localStorage に `mctcg.rankingApiUrl` をセットしてリロード → 送信ボタン有効、 押すと送信実行
- [ ] 「タイトルに戻る」 でタイトル画面に戻る
- [ ] 再度 「バトル開始」 で新規バトルが始まる
- [ ] JP / EN 切替でオーバーレイのテキストが追随

## 8. PR 構成

- ブランチ: `claude/day3-cpu-ai-and-gameover`
- コミット 1: SPEC-107 docs + changelog fragment
- コミット 2: index.html + css/battle.css に gameOverOverlay 追加
- コミット 3: js/battle/game-over.js + battle-ui.js + main.js 結線 + i18n キー
- コミット 4: SPEC-INDEX / CHANGELOG 再生成

## 9. 関連 SPEC

- SPEC-100: 3 日計画 (= 上位、 本 SPEC で Day 3 完了)
- SPEC-103 / 104 / 106: 前段、 本 SPEC の `finishBattle` から呼ばれる
- SPEC-013 (= 別途): ランキング backend B 本実装。 本 SPEC は UI スタブのみで、 API URL の設定は別途
