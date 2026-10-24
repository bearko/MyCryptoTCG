// tuning.js — 数値の釣り合いのつまみ（SPEC-113 §5）
//
// ルールの形は SPEC-113 で固定し、調整してよいのはこの 3 つだけ。
// 値を変えたら SPEC-113 §5 の「決めた値」の表と、tools/sim.mjs の結果をそろえる。
// ほかのファイルはこの値を直接書かず、ここから import する（1 か所で変えられるように）。

/** k：初期の兵 = 統率力 × k（newGame の開始時の 3 体と、SOUL で仲間になった部隊）。調整の範囲 1〜3 */
export const START_TROOPS_PER_LEAD = 2;

/** d：兵の食料の消費 = 兵 ÷ d（配給の倍率を掛ける）。調整の範囲 5〜12 */
export const TROOPS_PER_FOOD = 9;

/** m：農作の量 = 10 + 統治力 × m。調整の範囲 1〜2 */
export const FARM_PER_GOV = 1;

/** 3 つのつまみをまとめて読む（sim・テストの表示用） */
export const TUNING = Object.freeze({ k: START_TROOPS_PER_LEAD, d: TROOPS_PER_FOOD, m: FARM_PER_GOV });

/** 統率力から初期の兵 */
export function startTroops(lead) {
  return Math.floor(Math.max(0, lead || 0) * START_TROOPS_PER_LEAD);
}

/** 統治力から農作 1 回の食料 */
export function farmAmount(gov) {
  return 10 + Math.floor(Math.max(0, gov || 0) * FARM_PER_GOV);
}
