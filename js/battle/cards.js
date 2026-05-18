// ============================================================
// battle/cards.js — カード DB ロード + lookup
// ============================================================

import { loadJson } from "../data-loader.js";

const CARD_DB_PATHS = {
  heroes: "./data/cards/heroes.json",
};

/**
 * カード DB を fetch (= data-loader でキャッシュ)
 * @returns {Promise<{heroes: object[]}>}
 */
export async function loadCardDb() {
  const heroes = await loadJson("cards/heroes", CARD_DB_PATHS.heroes);
  return { heroes };
}

/**
 * heroes 配列から card id で 1 件取得
 * @param {{heroes: object[]}} cardDb
 * @param {string} id - "mch_1001" 等
 * @returns {object | undefined}
 */
export function getHeroDef(cardDb, id) {
  return cardDb.heroes.find((h) => h.id === id);
}
