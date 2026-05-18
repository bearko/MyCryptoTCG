**Added — ターンシステム + 召喚 / 攻撃 / 勝敗判定ロジック (Day 1 Phase 1B)**

- `js/battle/battle-logic.js` 新規。 純粋関数ベースのバトルロジック層 (= UI 非依存)
  - `startTurn(battle)`: ドロー → ストーン補充 (= +3、 上限 10) → 召喚酔い / 攻撃済みフラグ解除 → phase = "action"
  - `endTurn(battle)`: turn を player ↔ cpu で交代、 phase = "preStart"
  - `canSummon(side, cardId, cardDb, position)`: ストーン / hand 存在 / row 一致 / 空きスロット を `{ok, reason}` で返す
  - `summonHero(side, cardId, cardDb, position)`: コスト消費 + hand → field 移動、 summoningSick = true
  - `canAttack(unit)`: 召喚酔い / 攻撃済み / 撃破済み で false
  - `getValidAttackTargets(opponent)`: front 優先 → back → master の 1 件配列
  - `performAttack(side, opponent, attackerSlot, targetSlot)`: ダメージ適用 + 撃破判定 + 結果オブジェクト
  - `checkVictory(battle)`: masterHp 0 で勝敗確定 (= "player" / "cpu" / null)
  - `createFieldUnit(cardId, def)`: 場のユニット factory (= currentHp / maxHp / atk / summoningSick / attackedThisTurn)
- スキル発動ロジック (= `effect` 文字列の解釈) は Phase 2 で実装。 本 SPEC では skills 配列は read 可能だが actuate しない
- `js/main.js`: `window.__testBattleLogic()` smoke test を追加 (= turn / summon / attack 一連の流れを assert)
- UI / アニメ / CPU AI は本 SPEC のスコープ外 (= 後続 SPEC-104 〜 SPEC-106)
