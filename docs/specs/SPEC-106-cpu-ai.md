---
id: SPEC-106
title: CPU AI ルールベース (= 弱め貪欲) + アニメ結線 (Day 3 Phase 1E)
status: Implementing
pr: claude/day3-cpu-ai-and-gameover
phase: Phase 1E
kind: Added
---

# SPEC-106 — CPU AI ルールベース + アニメ結線

## 1. 目的

Day 2 SPEC-104 で `runCpuTurn` を auto-pass の shim として実装したが、 これでは
プレイヤーが攻撃される機会がなく バトルが一方的に終わる。 本 SPEC で **弱め
ルールベース AI** を入れ、 1 バトルが緊張感のある 5〜10 ターンで決着する状態にする。

「弱め」 の定義 (= kickoff 8 章):
- 最善手は使わない
- 単純な貪欲: 「召喚できるなら召喚」 「攻撃できるなら攻撃」 を繰り返す
- 召喚カード選択: コストが許す中で **最高コストを選ぶ** (= ストーンを使い切る)
- 攻撃対象: `getValidAttackTargets` 返り値の先頭 (= front → back → master の順)

## 2. スコープ

### In Scope

- `js/battle/cpu-ai.js` 新規:
  - `chooseCpuAction(battle)` (= 純粋関数、 次の 1 アクションを `{type: "summon"|"attack"|"end", ...}` で返す)
  - 内部ヘルパ: `findBestSummonCard(side, cardDb)` / `findReadyAttacker(side)`
- `js/battle/cpu-turn.js` 改修:
  - 旧 auto-pass を捨て、 `chooseCpuAction` をループで呼んで実行 (= 1 ターンで複数アクション可能)
  - 召喚 / 攻撃ごとに sprite アニメーションをトリガー (= triggerSummonAnim / triggerAttackAnim(side="cpu") / triggerHitAnim)
  - 各アクション間に演出ディレイ (= 700ms 召喚、 540ms 攻撃完了)
  - deck 切れは player の勝利、 endTurn 後に player の startTurn (= 既存仕様維持)

### Out of Scope

- 学習型 / 評価関数ベースの AI (= MVP は単純貪欲で十分)
- スキル発動の選択 (= スキル発動自体が Phase 2)
- 撤退 / レベルアップ / エクステンション (= Phase 2)
- マスター直撃を優先する強気 AI (= Phase 2 で難易度オプションとして導入候補)

## 3. 公開関数シグネチャ

### `js/battle/cpu-ai.js`

```js
export function chooseCpuAction(battle):
  | { type: "summon", cardId: string, position: "front"|"back" }
  | { type: "attack", attackerSlot: "front"|"back", targetSlot: "front"|"back"|"master" }
  | { type: "end" };
```

純粋関数 (= side effect なし)。 caller (= cpu-turn.js) が action を実行する。

## 4. AI 意思決定アルゴリズム

```
chooseCpuAction(battle):
  side = battle.cpu

  # 1. 召喚を検討 (= 最高コストの召喚可能カードを選ぶ)
  bestCard = null
  bestCost = -1
  for each cardId in side.hand:
    def = getHeroDef(cardDb, cardId)
    if canSummon(side, cardId, cardDb, def.row).ok and def.cost > bestCost:
      bestCard = { cardId, position: def.row }
      bestCost = def.cost
  if bestCard:
    return { type: "summon", ...bestCard }

  # 2. 攻撃を検討 (= 行動可能なユニットを front 優先で 1 体)
  for slot in ["front", "back"]:
    unit = side.field[slot]
    if canAttack(unit):
      targets = getValidAttackTargets(battle.player)
      return { type: "attack", attackerSlot: slot, targetSlot: targets[0] }

  # 3. それ以外は end
  return { type: "end" }
```

### 4-1. ループ実行

`cpu-turn.js` の `runCpuTurn` 内で:

```js
while (true) {
  const action = chooseCpuAction(battle);
  if (action.type === "end") break;
  await applyAction(action);   // 内部で animate + mutate + render + delay
  // checkVictory もこの中で見て、 player 撃破なら finishBattle("cpu") して break
}
endTurn(battle);
```

各アクション後に勝敗 check。 player master HP 0 になったら `finishBattle("cpu")`
で player の startTurn を呼ばずに終了。

## 5. アニメーション結線

### 5-1. summon

```js
summonHero(battle.cpu, cardId, cardDb, position);
renderBattle();
const newPortrait = $(`#cpuField${cap(position)} .field-slot__portrait`);
triggerSummonAnim(newPortrait);
await delay(700);
```

### 5-2. attack

```js
const attackerEl = $(`#cpuField${cap(attackerSlot)} .field-slot__portrait`);
const targetEl = targetSlot === "master"
  ? $(".battle-side--player .battle-side__info")
  : $(`#playerField${cap(targetSlot)} .field-slot__portrait`);

triggerAttackAnim(attackerEl, "cpu");
await delay(180);
performAttack(battle.cpu, battle.player, attackerSlot, targetSlot);
if (targetEl) triggerHitAnim(targetEl);
await delay(360);
renderBattle();
```

## 6. テスト計画

### 6-1. Node 側 (= 決定的)

- [ ] `chooseCpuAction` を空 hand + 空 field で呼ぶと `{type: "end"}` を返す
- [ ] hand に cost 2 / 3 / 4 のカード混在 + stones 5 だと cost 3 のカードを選ぶ (= 5 ≥ 3、 4 は cost 不足) ... ※ 実装は「最高コストかつ召喚可能」 なので cost 3 が選ばれる
- [ ] hand に cost 2 / 3 のカード + stones 5 だと cost 3 を選ぶ
- [ ] field に 行動可能ユニット + 攻撃対象 (= player.field.front) があると `{type: "attack", attackerSlot, targetSlot: "front"}`
- [ ] field に 行動可能ユニット + player.field 全空 だと `{type: "attack", targetSlot: "master"}`
- [ ] field に summoningSick のユニットのみ → 攻撃は出ない、 召喚もできなければ `{type: "end"}`

### 6-2. ブラウザ手動テスト

- [ ] CPU 1 ターン目: stones 3 で cost ≤ 3 のカードを召喚する
- [ ] CPU 2 ターン目: 自軍ユニットの召喚酔いが解け、 player ユニットがいなければ master に攻撃
- [ ] player の field に front 召喚済の場合、 CPU は front を攻撃する
- [ ] 自軍 master HP が CPU の attack で減る (= triggerHitAnim で player info shake)
- [ ] CPU 撃破時の演出ディレイがプレイヤーに十分認識できる (= 540ms 以上)
- [ ] バトルが 5〜10 ターンで決着する (= player / cpu どちらでも)
- [ ] is-cpu-thinking 中は player の操作が無効

## 7. PR 構成

- ブランチ: `claude/day3-cpu-ai-and-gameover`
- コミット 1: SPEC-106 docs + changelog fragment
- コミット 2: `js/battle/cpu-ai.js` 新規
- コミット 3: `js/battle/cpu-turn.js` 改修 (= AI ループ + アニメ結線)

## 8. 関連 SPEC

- SPEC-100: 3 日計画 (= 上位)
- SPEC-103: Phase 1B (= battle-logic 純粋関数群、 本 SPEC が呼び出す)
- SPEC-104: Phase 1C (= UI、 本 SPEC の AI 結果を反映)
- SPEC-105: Phase 1D (= sprite アニメ、 本 SPEC の CPU 攻撃でも使う)
- SPEC-107: Phase 1F (= 次段、 勝敗画面)
