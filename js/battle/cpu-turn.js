// ============================================================
// battle/cpu-turn.js — CPU ターン shim (= Phase 1E SPEC-106 AI に置換予定)
// ============================================================
// 本ファイルは Phase 1C SPEC-104 の MVP として CPU を auto-pass で動かす shim。
// Phase 1E で本格 AI (= tickCpuTurn / applyCpuAction 等) に置き換える前提なので
// 詳細な意思決定ロジックはここに入れない。

import { state } from "../state.js";
import { startTurn, endTurn } from "./battle-logic.js";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * CPU のターン進行を最後まで回す:
 *   1. phase = "cpuThinking" にして演出ディレイ
 *   2. CPU の startTurn (= ドロー + ストーン補充)
 *      → deck 切れなら player の勝利で終了
 *   3. (= AI 行動はここ。 Phase 1C では何もしない)
 *   4. endTurn (= player に turn を戻す)
 *   5. player の startTurn (= ドロー + ストーン補充)
 *      → deck 切れなら cpu の勝利で終了
 *   6. UI を最終 render
 *
 * @param {() => void} renderBattle - UI 再描画関数
 * @param {(winner: "player"|"cpu") => void} finishBattle - 勝敗確定 callback
 */
export async function runCpuTurn(renderBattle, finishBattle) {
  const battle = state.battle;
  if (!battle) return;

  battle.phase = "cpuThinking";
  renderBattle();
  await delay(900);

  const cpuStart = startTurn(battle);
  if (cpuStart.deckEmpty) {
    finishBattle("player");
    return;
  }
  renderBattle();
  await delay(1200);

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
