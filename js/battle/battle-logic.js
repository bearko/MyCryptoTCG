// ============================================================
// battle/battle-logic.js — ターン / 召喚 / 攻撃 / 勝敗判定の純粋関数群
// ============================================================

import { drawCard } from "./deck.js";
import { getHeroDef } from "./cards.js";
import { STONES_PER_TURN, MAX_STONES } from "./battle-state.js";

// ============================================================
// Field unit factory
// ============================================================

/**
 * 場のユニット shape を作る
 * @param {string} cardId
 * @param {object} def - getHeroDef で取得した hero def
 * @returns {object}
 */
export function createFieldUnit(cardId, def) {
  return {
    cardId,
    name: def.name,
    currentHp: def.hp,
    maxHp: def.hp,
    atk: def.atk,
    row: def.row,
    summoningSick: true,
    attackedThisTurn: false,
  };
}

// ============================================================
// Turn lifecycle
// ============================================================

/**
 * 現在のターン主の startTurn:
 *   1. ドロー (= deck 切れなら drawn: null を返す → caller が敗北確定)
 *   2. ストーン補充 (= +3、 上限 10)
 *   3. 自軍 field の召喚酔い / 攻撃済みフラグ解除
 *   4. phase = "action", turnNumber++
 * @param {object} battle - state.battle
 * @returns {{drawn: string|null, deckEmpty: boolean, stonesGained: number}}
 */
export function startTurn(battle) {
  const side = battle.turn === "player" ? battle.player : battle.cpu;

  const drawn = drawCard(side);
  if (drawn === null) {
    return { drawn: null, deckEmpty: true, stonesGained: 0 };
  }

  const before = side.stones;
  side.stones = Math.min(side.stones + STONES_PER_TURN, MAX_STONES);
  const stonesGained = side.stones - before;

  if (side.field.front) {
    side.field.front.summoningSick = false;
    side.field.front.attackedThisTurn = false;
  }
  if (side.field.back) {
    side.field.back.summoningSick = false;
    side.field.back.attackedThisTurn = false;
  }

  battle.phase = "action";
  battle.turnNumber++;

  return { drawn, deckEmpty: false, stonesGained };
}

/**
 * ターン主を交代 (= player ↔ cpu)、 phase を preStart に戻す
 * @param {object} battle
 */
export function endTurn(battle) {
  battle.turn = battle.turn === "player" ? "cpu" : "player";
  battle.phase = "preStart";
}

// ============================================================
// Summon
// ============================================================

/**
 * 召喚可能か判定
 * @param {object} side
 * @param {string} cardId
 * @param {{heroes: object[]}} cardDb
 * @param {"front"|"back"} position
 * @returns {{ok: boolean, reason?: string}}
 */
export function canSummon(side, cardId, cardDb, position) {
  const def = getHeroDef(cardDb, cardId);
  if (!def) return { ok: false, reason: "no_def" };
  if (!side.hand.includes(cardId)) return { ok: false, reason: "not_in_hand" };
  if (side.stones < def.cost) return { ok: false, reason: "not_enough_stones" };
  if (def.row !== position) return { ok: false, reason: "wrong_row" };
  if (side.field[position] !== null) return { ok: false, reason: "slot_occupied" };
  return { ok: true };
}

/**
 * 召喚を実行 (= canSummon が ok 前提、 失敗時は throw)
 * @param {object} side
 * @param {string} cardId
 * @param {{heroes: object[]}} cardDb
 * @param {"front"|"back"} position
 * @returns {object} 場に置かれた FieldUnit
 */
export function summonHero(side, cardId, cardDb, position) {
  const check = canSummon(side, cardId, cardDb, position);
  if (!check.ok) {
    throw new Error(`summonHero failed: ${check.reason}`);
  }
  const def = getHeroDef(cardDb, cardId);
  side.stones -= def.cost;

  const idx = side.hand.indexOf(cardId);
  side.hand.splice(idx, 1);

  const unit = createFieldUnit(cardId, def);
  side.field[position] = unit;
  return unit;
}

// ============================================================
// Attack
// ============================================================

/**
 * @param {object|null} unit - field の ユニット (= null なら攻撃不可)
 * @returns {boolean}
 */
export function canAttack(unit) {
  if (!unit) return false;
  if (unit.summoningSick) return false;
  if (unit.attackedThisTurn) return false;
  if (unit.currentHp <= 0) return false;
  return true;
}

/**
 * 攻撃可能な対象を返す (= front 優先 → back → master の 1 件)
 * @param {object} opponent
 * @returns {("front"|"back"|"master")[]}
 */
export function getValidAttackTargets(opponent) {
  if (opponent.field.front && opponent.field.front.currentHp > 0) return ["front"];
  if (opponent.field.back && opponent.field.back.currentHp > 0) return ["back"];
  return ["master"];
}

/**
 * 攻撃を実行
 * @param {object} side - 攻撃側
 * @param {object} opponent - 被攻撃側
 * @param {"front"|"back"} attackerSlot
 * @param {"front"|"back"|"master"} targetSlot
 * @returns {{hit: string, damage: number, destroyed: boolean, remainingHp?: number}}
 */
export function performAttack(side, opponent, attackerSlot, targetSlot) {
  const attacker = side.field[attackerSlot];
  if (!canAttack(attacker)) {
    throw new Error(`performAttack: cannot attack (slot=${attackerSlot})`);
  }
  const valid = getValidAttackTargets(opponent);
  if (!valid.includes(targetSlot)) {
    throw new Error(`performAttack: invalid target ${targetSlot}, valid=${valid.join(",")}`);
  }

  attacker.attackedThisTurn = true;
  const damage = attacker.atk;

  if (targetSlot === "master") {
    opponent.masterHp = Math.max(0, opponent.masterHp - damage);
    return {
      hit: "master",
      damage,
      destroyed: opponent.masterHp === 0,
      remainingHp: opponent.masterHp,
    };
  }

  const target = opponent.field[targetSlot];
  target.currentHp -= damage;
  let destroyed = false;
  if (target.currentHp <= 0) {
    destroyed = true;
    opponent.field[targetSlot] = null;
  }
  return {
    hit: targetSlot,
    damage,
    destroyed,
    remainingHp: destroyed ? 0 : target.currentHp,
  };
}

// ============================================================
// Victory check
// ============================================================

/**
 * 勝敗判定 (= masterHp 0 で確定、 deck 切れは caller 責任)
 * @param {object} battle
 * @returns {"player"|"cpu"|null}
 */
export function checkVictory(battle) {
  if (battle.player.masterHp <= 0) return "cpu";
  if (battle.cpu.masterHp <= 0) return "player";
  return null;
}
