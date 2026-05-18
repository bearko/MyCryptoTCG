---
id: SPEC-103
title: ターンシステム + 召喚 / 攻撃 / 勝敗判定ロジック (Day 1 Phase 1B)
status: Implementing
pr: claude/import-kickoff-document-bQ6rP
phase: Phase 1B
kind: Added
---

# SPEC-103 — ターンシステム + 召喚 / 攻撃 / 勝敗判定ロジック

## 1. 目的

Phase 1A (= SPEC-102) で確立した `state.battle` 上にカードヒーロー DS 高速版の
**ターン構造とアクションロジック** を実装する。 UI は **本 SPEC のスコープ外**
で、 純粋関数として呼び出し可能な API のみを提供する。

## 2. スコープ

### In Scope

- `js/battle/battle-logic.js` 新規
  - `startTurn(battle)` (= ドロー + ストーン補充 + 召喚酔い / 攻撃済みフラグ解除)
  - `endTurn(battle)` (= ターン交代、 phase リセット)
  - `canSummon(side, cardId, cardDb, position)` (= ストーン / row / 空きスロット 判定)
  - `summonHero(side, cardId, cardDb, position)` (= 召喚処理)
  - `canAttack(unit)` (= 召喚酔い / 攻撃済み / HP > 0)
  - `getValidAttackTargets(opponent)` (= front → back → master の順で攻撃可能対象)
  - `performAttack(side, opponent, attackerSlot, targetSlot)` (= ダメージ適用 + 撃破判定)
  - `checkVictory(battle)` (= masterHp 0 または deck-out で勝敗確定)
  - `createFieldUnit(cardId, def)` (= 場のユニット shape を作る factory)
- `js/main.js`: `window.__testBattleLogic()` を追加 (= turn / summon / attack の一連の動作を smoke test)

### Out of Scope

- とくぎ (= スキル) 発動ロジック (= `cost / effect` の解釈は Phase 2 で実装)
- レベルアップ / エクステンション装備 (= Phase 2、 SPEC-008/009)
- UI / DOM 描画 (= Phase 1C SPEC-104)
- アニメーション (= Phase 1D SPEC-105)
- CPU AI (= Phase 1E SPEC-106)

## 3. データ構造拡張

### 3-1. 場のユニット (= `side.field.front` / `side.field.back`)

```js
{
  cardId: "mch_1001",
  name: { ja: "コナン・ドイル", en: "Arthur Conan Doyle" },
  currentHp: 2,
  maxHp: 2,
  atk: 2,
  row: "back",
  summoningSick: true,      // 召喚されたターンは true
  attackedThisTurn: false,  // 1 ターン 1 回攻撃の制約
}
```

`buffs` / `debuffs` 等のステータス変更は Phase 2 (= スキル / エクステンション)
で導入。 Phase 1B では純粋に `currentHp` / `atk` の直接操作のみ。

### 3-2. `battle.phase`

| phase | 意味 | 遷移元 → 先 |
|---|---|---|
| `preStart` | バトル開始直後 or ターン終了直後 | initBattle → preStart、 endTurn → preStart |
| `action` | ターン主のアクションフェーズ | startTurn → action |
| `gameOver` | 勝敗確定 | checkVictory が non-null を返した時 |

`draw` / `refill` は startTurn 内部で逐次処理するため、 ユーザー観測可能な
phase としては `preStart` → `action` の 2 段階のみ。

## 4. ターン進行ルール (= KICKOFF 2-2 採用版)

```
[startTurn]
  1. ドロー (= deck の先頭を hand に移動)
     - deck 切れなら drawn = null を返す → caller が checkVictory で確定
  2. ストーン補充 (= +STONES_PER_TURN = 3、 上限 MAX_STONES = 10)
  3. 自軍 field の全ユニットの summoningSick = false, attackedThisTurn = false
  4. battle.phase = "action", battle.turnNumber++

[action phase] (= UI からの操作で順次呼ばれる)
  - summonHero(side, cardId, cardDb, position)
    - canSummon が ok ならストーン消費、 hand から field へ
    - 新規ユニットは summoningSick = true (= 同ターン攻撃不可)
  - performAttack(side, opponent, attackerSlot, targetSlot)
    - canAttack が ok かつ targetSlot が getValidAttackTargets に含まれる場合のみ
    - 攻撃側の atk を targetSlot の currentHp / masterHp に適用
    - attackedThisTurn = true
    - target の currentHp が 0 以下なら field[slot] = null

[endTurn]
  - battle.turn = (player ↔ cpu) で交代
  - battle.phase = "preStart"
  - (= 次の startTurn 呼び出しで先頭から)
```

### 4-1. 攻撃対象の優先順位

`getValidAttackTargets(opponent)` は以下の通り 1 つだけ返す:

| opponent.field.front | opponent.field.back | 結果 |
|---|---|---|
| 存在 | (任意) | `["front"]` |
| null | 存在 | `["back"]` |
| null | null | `["master"]` |

(= front を倒さないと back に攻撃できない、 ユニットが全滅して初めてマスター
直撃可能、 という DS カードヒーロー高速版の挙動を再現)

### 4-2. 勝敗確定

`checkVictory(battle)` は以下を判定:

- `battle.player.masterHp <= 0` → `"cpu"` 勝利
- `battle.cpu.masterHp <= 0` → `"player"` 勝利
- それ以外 → `null`

deck 切れによる敗北は、 `startTurn` の戻り値 `drawn === null` を caller が見て
`{loser: battle.turn}` として確定させる責任を持つ (= 関数の責任分離)。
判定が確定したら caller が `battle.phase = "gameOver"` をセット。

## 5. 公開関数シグネチャ

```js
// js/battle/battle-logic.js

export function startTurn(battle): {
  drawn: string | null,      // 引いたカード id (= deck 切れなら null)
  deckEmpty: boolean,
  stonesGained: number,      // 補充された量 (= 上限切り上げ後)
};

export function endTurn(battle): void;

export function canSummon(side, cardId, cardDb, position): {
  ok: boolean,
  reason?: "no_def" | "not_in_hand" | "not_enough_stones" | "wrong_row" | "slot_occupied",
};

export function summonHero(side, cardId, cardDb, position): FieldUnit;  // 失敗時は throw

export function canAttack(unit): boolean;

export function getValidAttackTargets(opponent): ("front" | "back" | "master")[];

export function performAttack(side, opponent, attackerSlot, targetSlot): {
  hit: "front" | "back" | "master",
  damage: number,
  destroyed: boolean,        // ユニット撃破 or マスター HP 0 到達
  remainingHp?: number,      // master 攻撃時の残 HP
};

export function checkVictory(battle): "player" | "cpu" | null;

export function createFieldUnit(cardId, def): FieldUnit;  // factory (= internal but exported for testing)
```

## 6. テスト計画 (= `window.__testBattleLogic` 内で実行)

1. `initBattle(deck, deck)` → `startTurn(battle)` で player が 1 枚引き + ストーン +3
2. `canSummon(player, "mch_1001", db, "back")` が `{ok: true}` (= cost 2 ≤ stones 3)
3. `summonHero(...)` 後、 `field.back.summoningSick === true`、 `canAttack(...)` が false
4. `endTurn(battle)` → battle.turn === "cpu"、 `startTurn` で CPU も同じく機能
5. ターンを 1 周回した後、 `canAttack(player.field.back) === true`
6. `getValidAttackTargets(cpu)` が `["back"]` または `["master"]` を文脈通り返す
7. `performAttack(player, cpu, "back", "master")` で `cpu.masterHp` が `10 - atk` に
8. master を 10/atk 回攻撃すると `checkVictory` が `"player"` を返す
9. deck 切れの side で `startTurn` を呼ぶと `drawn: null, deckEmpty: true`

## 7. PR 構成

- ブランチ: `claude/import-kickoff-document-bQ6rP` (= 継続)
- コミット 1: SPEC-103 docs + changelog fragment
- コミット 2: 実装 (`js/battle/battle-logic.js` + `js/main.js` の `__testBattleLogic`)
- コミット 3: SPEC-INDEX / CHANGELOG 再生成

## 8. 関連 SPEC

- SPEC-100: 3 日計画 (= 上位)
- SPEC-102: Phase 1A (= 前段、 deck / hand / state)
- SPEC-104: Phase 1C (= 次段、 UI 結線で本ロジックを呼び出す)
