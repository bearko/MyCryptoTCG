// ============================================================
// battle/cpu-turn.js — CPU ターン進行 (= Phase 1E SPEC-106 AI 組込済)
// ============================================================

import { state } from "../state.js";
import {
  startTurn,
  endTurn,
  summonHero,
  performAttack,
  checkVictory,
} from "./battle-logic.js";
import { chooseCpuAction } from "./cpu-ai.js";
import {
  triggerSummonAnim,
  triggerAttackAnim,
  triggerHitAnim,
} from "./sprite.js";

const $ = (sel, root = document) => root.querySelector(sel);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const SAFETY_ACTION_LIMIT = 20; // ターン内の暴走防止

/**
 * CPU のターンを最後まで回す:
 *   1. phase = "cpuThinking" + render + 演出ディレイ
 *   2. CPU の startTurn (= draw + stones+3)
 *      → deck 切れなら player 勝利で finishBattle
 *   3. chooseCpuAction ループで summon / attack を順次実行
 *      → 各アクションごとに sprite アニメ + delay + render + 勝敗 check
 *   4. endTurn (= turn を player に戻す)
 *   5. player の startTurn
 *      → deck 切れなら cpu 勝利で finishBattle
 *   6. UI を最終 render
 *
 * @param {() => void} renderBattle
 * @param {(winner: "player"|"cpu") => void} finishBattle
 */
export async function runCpuTurn(renderBattle, finishBattle) {
  const battle = state.battle;
  if (!battle) return;

  battle.phase = "cpuThinking";
  renderBattle();
  await delay(700);

  const cpuStart = startTurn(battle);
  if (cpuStart.deckEmpty) {
    finishBattle("player");
    return;
  }
  renderBattle();
  await delay(600);

  // AI 意思決定ループ
  for (let i = 0; i < SAFETY_ACTION_LIMIT; i++) {
    const action = chooseCpuAction(battle);
    if (action.type === "end") break;

    if (action.type === "summon") {
      const finished = await doSummon(action, renderBattle, finishBattle);
      if (finished) return;
      continue;
    }
    if (action.type === "attack") {
      const finished = await doAttack(action, renderBattle, finishBattle);
      if (finished) return;
      continue;
    }
    // 未知 type は安全のため break
    console.warn("[cpu-turn] unknown action:", action);
    break;
  }

  endTurn(battle);
  renderBattle();
  await delay(300);

  const playerStart = startTurn(battle);
  if (playerStart.deckEmpty) {
    finishBattle("cpu");
    return;
  }
  renderBattle();
}

/**
 * CPU の召喚を実行 + アニメ
 * @returns {Promise<boolean>} true なら勝敗確定で early-return
 */
async function doSummon(action, renderBattle, finishBattle) {
  const battle = state.battle;
  try {
    summonHero(battle.cpu, action.cardId, battle.cardDb, action.position);
  } catch (e) {
    console.warn("[cpu-turn] summon failed:", e.message);
    return false;
  }
  renderBattle();

  const newPortrait = $(`#cpuField${capitalize(action.position)} .field-slot__portrait`);
  triggerSummonAnim(newPortrait);
  await delay(700);
  return false;
}

/**
 * CPU の攻撃を実行 + アニメ
 * @returns {Promise<boolean>} true なら勝敗確定で early-return
 */
async function doAttack(action, renderBattle, finishBattle) {
  const battle = state.battle;

  const attackerEl = $(`#cpuField${capitalize(action.attackerSlot)} .field-slot__portrait`);
  const targetEl = action.targetSlot === "master"
    ? $(".battle-side--player .battle-side__info")
    : $(`#playerField${capitalize(action.targetSlot)} .field-slot__portrait`);

  triggerAttackAnim(attackerEl, "cpu");
  await delay(180);

  try {
    performAttack(battle.cpu, battle.player, action.attackerSlot, action.targetSlot);
  } catch (e) {
    console.warn("[cpu-turn] attack failed:", e.message);
    return false;
  }

  if (targetEl) triggerHitAnim(targetEl);
  await delay(360);
  renderBattle();

  const winner = checkVictory(battle);
  if (winner) {
    finishBattle(winner);
    return true;
  }
  return false;
}
