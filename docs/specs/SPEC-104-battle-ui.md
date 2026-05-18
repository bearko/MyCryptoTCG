---
id: SPEC-104
title: バトル画面 UI + 手札/場/マスター枠のタップ操作 (Day 2 Phase 1C)
status: Implementing
pr: claude/day2-battle-ui-and-sprites
phase: Phase 1C
kind: Added
---

# SPEC-104 — バトル画面 UI + タップ操作

## 1. 目的

Phase 1B (= SPEC-103) で構築した純粋関数ベースの `battle-logic.js` を **DOM に
結線** する。 プレイヤーは手札タップでヒーローを召喚し、 場のユニットタップで
攻撃でき、 End Turn で次ターンへ進める一連の流れがブラウザで動く状態になる。

CPU は本 SPEC では **自動 pass** (= AI なし、 1.5 秒の演出ディレイ後に endTurn)。
本格 AI は Phase 1E (= SPEC-106) で実装。

## 2. スコープ

### In Scope

- `index.html`: `#battleScreen` セクション追加 (= CPU 側 + 中央 divider + プレイヤー 側)
- `css/battle.css` 新規: バトル画面用スタイル (= field-slot / hand-card / battle-side / divider)
- `js/battle/battle-ui.js` 新規:
  - `renderBattle()`: state.battle を見て全 DOM を再描画
  - `enterBattleScreen()` / `exitBattleScreen()`: screen 遷移
  - `setupBattleUiEventListeners()`: 一括イベントバインド
  - UI state machine: `idle` / `summoning` / `attacking`
- `js/battle/cpu-turn.js` 新規 (= Phase 1E の AI に置換するための shim):
  - `runCpuTurn()`: startTurn → 1.5s delay → endTurn → player turn auto-start
- `js/main.js`:
  - 「Press to Start」 → デモバトル開始 (= `initBattle` + `enterBattleScreen` + player startTurn)
  - 既存 `#app` の `.stage` 内 placeholder を battle 画面起点に置き換える
- `data/i18n/ui.json`: バトル UI 用 i18n キー追加 (= 約 15 キー)

### Out of Scope

- スプライトアニメ (= Phase 1D SPEC-105)
- CPU AI (= Phase 1E SPEC-106、 本 SPEC では auto-pass)
- 勝敗画面 / ランキング送信 (= Phase 1F SPEC-107)
- スキル発動 / レベルアップ (= Phase 2)
- 演出系 effects (= 既存 confetti / float の利用は最小限のみ)

## 3. UI レイアウト

縦並び portrait-first レイアウト。 PC では `max-width: 480px` で中央配置。

```
┌───────────────────────────────────┐
│ CPU info: HP10 / Stones 0 / Hand 5│
│ ▭ ▭ ▭ ▭ ▭  (= hand-back の数)      │
│      [back slot]                   │
│      [front slot]                  │
│ ─── battle-divider ───             │
│  Turn 1 — Your Turn  Action        │
│  [End Turn]                        │
│ ─────────────────────────────       │
│      [front slot]                  │
│      [back slot]                   │
│ [card1] [card2] [card3] (hand)     │
│ Your info: HP10 / Stones 3         │
│ Hint: ヒーローをタップして召喚...  │
└───────────────────────────────────┘
```

### 3-1. field-slot 状態

| 状態 | クラス | 表示 |
|---|---|---|
| 空 | `field-slot--empty` | 点線枠 + 「Empty」 |
| 召喚済 (= sick) | `field-slot--occupied field-slot--sick` | 半透明 + portrait + HP / ATK バッジ |
| 召喚済 (= 行動可) | `field-slot--occupied` | portrait + HP / ATK バッジ |
| 撃破直後 | (= field[slot]=null になるので空状態に戻る) | - |
| ハイライト (= ターゲット候補) | `field-slot--highlight-target` | accent 枠 |

### 3-2. hand-card 状態

| 状態 | クラス | 表示 |
|---|---|---|
| 通常 | `hand-card` | portrait + name + cost + atk/hp |
| 召喚不可 (= cost 不足) | `hand-card hand-card--disabled` | 半透明 |
| 選択中 | `hand-card hand-card--selected` | accent 枠 + 上に浮き上がる |

## 4. UI State Machine

```
idle (= 初期)
  ├── タップ: hand-card (= disabled でないもの)
  │   → state = "summoning", selectedCard = cardId
  │   → 対応する row の field-slot にハイライト
  ├── タップ: 自軍 field-slot (= occupied かつ canAttack)
  │   → state = "attacking", selectedAttacker = slot
  │   → getValidAttackTargets の slot にハイライト
  └── タップ: End Turn
      → endTurn + runCpuTurn

summoning
  ├── タップ: ハイライト中の field-slot
  │   → summonHero、 renderBattle、 state = "idle"
  ├── タップ: 別の hand-card
  │   → selectedCard を更新 (= ハイライト切替)
  └── タップ: 上記以外
      → state = "idle" (= キャンセル)

attacking
  ├── タップ: ハイライト中の対象 (= front / back / master)
  │   → performAttack、 renderBattle、 state = "idle"
  ├── タップ: 別の自軍 occupied unit
  │   → selectedAttacker を更新
  └── タップ: 上記以外
      → state = "idle"
```

CPU ターン中はすべてのタップを無視 (= overlay でブロック)。

## 5. CPU ターン shim (= Phase 1E まで)

```js
async function runCpuTurn() {
  battle.phase = "cpuThinking";   // UI 状態を表す疑似 phase (= state-machine とは別)
  renderBattle();
  await delay(900);   // ドロー演出
  const r = startTurn(battle);
  if (r.deckEmpty) {
    return endBattleByDeckOut("cpu");
  }
  renderBattle();
  await delay(1200);  // 思考演出
  endTurn(battle);    // CPU は何もせず終わる
  renderBattle();
  await delay(300);

  // player turn auto-start
  const pr = startTurn(battle);
  if (pr.deckEmpty) {
    return endBattleByDeckOut("player");
  }
  renderBattle();
}
```

(= 動詞 prefix: `runCpuTurn` は CLAUDE.md の prefix 一覧にはないが、 trigger* に
近い意図。 内部処理は startTurn / endTurn の関数を呼び出すだけで、 新規動詞は
作らない。 prefix を厳格に保ちたければ `triggerCpuTurn` に renaming するが、
Phase 1E でリプレースされる shim のため `runCpuTurn` で許容する)

## 6. 初期化と決着

### 6-1. デモバトル初期化

```js
const DEMO_DECK = [
  "mch_1001", "mch_1002", "mch_1003",
  "mch_1001", "mch_1002", "mch_1003",
];   // 各 2 枚 × 3 種 = 6 枚 (= デモバトルは 5〜10 ターンで決着する想定)

await initBattle(DEMO_DECK.slice(), DEMO_DECK.slice());
```

### 6-2. 決着判定

毎 action 後に `checkVictory(battle)` を呼び、 戻り値が non-null なら:

```js
battle.phase = "gameOver";
battle.winner = "player" | "cpu";
showSimpleGameOverHint();   // 仮: divider に勝敗を表示するだけ
```

(= 本格的な勝敗画面は SPEC-107 で実装)

deck-out (= startTurn が drawn:null) も同様に `winner = 相手` で確定。

## 7. テスト計画

### 7-1. ブラウザ手動テスト

- [ ] タイトルから 「Press to Start」 で `#battleScreen` が表示される
- [ ] CPU 側 / プレイヤー側 双方の HP / Stones / Hand 数が表示される
- [ ] プレイヤーの初手ドロー後、 hand に 1 枚カードが見える、 stones は 3
- [ ] cost ≤ stones のカードを選ぶと field-slot がハイライト
- [ ] ハイライトされた slot をタップすると召喚成功、 hand から消える
- [ ] 召喚直後のユニットをタップしても (= sick) ハイライトが付かない
- [ ] End Turn → 1〜2 秒後に CPU が pass、 自動的に自ターン再開
- [ ] 2 ターン目で自軍ユニットをタップすると targets がハイライトされる
- [ ] master をタップで CPU の HP が `atk` 分減る
- [ ] CPU master HP 0 で divider に 「Victory」 が出る
- [ ] JP / EN 切替が hand-card 名 / hint テキスト両方で動く
- [ ] PC (1280×800) / Mobile (375×667) で破綻なし

### 7-2. console 検証

- [ ] `state.battle.player.deck.length` が初期 6
- [ ] 召喚後 `state.battle.player.field.front.summoningSick === true`
- [ ] 次ターン startTurn 後 `summoningSick === false`、 `canAttack` が true

## 8. PR 構成

- ブランチ: `claude/day2-battle-ui-and-sprites`
- コミット 1: SPEC-104 docs + changelog fragment
- コミット 2: HTML + CSS (= battle screen markup + battle.css)
- コミット 3: js/battle/battle-ui.js + cpu-turn.js + main.js 結線
- コミット 4: i18n キー追加
- コミット 5: SPEC-INDEX / CHANGELOG 再生成

## 9. 関連 SPEC

- SPEC-100: 3 日計画 (= 上位)
- SPEC-103: Phase 1B (= 前段、 battle-logic.js)
- SPEC-105: Phase 1D (= 次段、 スプライトアニメ。 本 SPEC の field-slot に sprite 要素を追加する形)
- SPEC-106: Phase 1E (= CPU AI、 本 SPEC の `runCpuTurn` を置換)
- SPEC-107: Phase 1F (= 勝敗画面、 本 SPEC の `showSimpleGameOverHint` を置換)
