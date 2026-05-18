// ============================================================
// battle/battle-state.js — バトル state 構築 / アクセサ
// ============================================================

import { state } from "../state.js";
import { loadCardDb } from "./cards.js";
import { shuffleDeck } from "./deck.js";

// ============================================================
// バトル定数
// ============================================================
export const INITIAL_MASTER_HP = 10;
export const INITIAL_STONES = 0;
export const INITIAL_HAND_SIZE = 5;
export const MAX_HAND_SIZE = 7;
export const STONES_PER_TURN = 3;
export const MAX_STONES = 10;

/**
 * バトル side の初期 state を作る
 * deck は shuffle 済み、 hand は空、 field は null
 * @param {string[]} deckCardIds - 山札に積む card id の配列 (= caller が複製を渡す前提だが念のため slice)
 * @returns {object}
 */
export function newBattleSide(deckCardIds) {
  return {
    deck: shuffleDeck(deckCardIds.slice()),
    hand: [],
    stones: INITIAL_STONES,
    masterHp: INITIAL_MASTER_HP,
    field: {
      front: null,
      back: null,
    },
  };
}

/**
 * バトル全体を初期化 (= card DB ロード + player / cpu の side を作って state.battle に格納)
 * @param {string[]} playerDeckIds
 * @param {string[]} cpuDeckIds
 * @returns {Promise<object>} 初期化された state.battle
 */
export async function initBattle(playerDeckIds, cpuDeckIds) {
  const cardDb = await loadCardDb();
  state.battle = {
    cardDb,
    player: newBattleSide(playerDeckIds),
    cpu: newBattleSide(cpuDeckIds),
    turn: "player",
    turnNumber: 0,
    phase: "preStart",
  };
  return state.battle;
}

/**
 * @returns {object | null} state.battle (= バトル外なら null)
 */
export function getBattle() {
  return state.battle;
}
