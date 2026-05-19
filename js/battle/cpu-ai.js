// ============================================================
// battle/cpu-ai.js — CPU AI 意思決定 (= 純粋関数、 副作用なし)
// ============================================================
// 「弱め」 ルールベース AI (= MYCRYPTOTCG-KICKOFF 8 章)。 評価関数なし、 単純貪欲:
//   1. 召喚可能なら 最高コストのカードを召喚
//   2. 攻撃可能なら front → back の順で 1 体使い、 getValidAttackTargets 先頭を狙う
//   3. それ以外は end
//
// caller (= cpu-turn.js) が返り値 action を実際に apply する。 副作用は caller 側。

import { getHeroDef } from "./cards.js";
import { canSummon, canAttack, getValidAttackTargets } from "./battle-logic.js";

/**
 * @typedef {{type: "summon", cardId: string, position: "front"|"back"}} SummonAction
 * @typedef {{type: "attack", attackerSlot: "front"|"back", targetSlot: "front"|"back"|"master"}} AttackAction
 * @typedef {{type: "end"}} EndAction
 * @typedef {SummonAction | AttackAction | EndAction} CpuAction
 */

/**
 * 次の 1 アクションを決定する
 * @param {object} battle - state.battle
 * @returns {CpuAction}
 */
export function chooseCpuAction(battle) {
  const cpu = battle.cpu;
  const cardDb = battle.cardDb;

  // 1. 召喚 (= 最高コストの召喚可能カード)
  const summon = findBestSummonCard(cpu, cardDb);
  if (summon) return { type: "summon", ...summon };

  // 2. 攻撃 (= 行動可能ユニットを front 優先で 1 体)
  for (const slot of ["front", "back"]) {
    const unit = cpu.field[slot];
    if (canAttack(unit)) {
      const targets = getValidAttackTargets(battle.player);
      return { type: "attack", attackerSlot: slot, targetSlot: targets[0] };
    }
  }

  // 3. end
  return { type: "end" };
}

/**
 * 手札から canSummon ok なカードのうち最高コストを選ぶ
 * 同コストが複数あれば手札の先頭側を優先 (= 安定動作)
 * @param {object} side
 * @param {object} cardDb
 * @returns {{cardId: string, position: "front"|"back"} | null}
 */
function findBestSummonCard(side, cardDb) {
  let best = null;
  let bestCost = -1;
  for (const cardId of side.hand) {
    const def = getHeroDef(cardDb, cardId);
    if (!def) continue;
    const check = canSummon(side, cardId, cardDb, def.row);
    if (!check.ok) continue;
    if (def.cost > bestCost) {
      best = { cardId, position: def.row };
      bestCost = def.cost;
    }
  }
  return best;
}
