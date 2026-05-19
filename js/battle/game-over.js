// ============================================================
// battle/game-over.js — 勝敗画面 + ランキング送信 UI + タイトル復帰
// ============================================================

import { state, pauseTime, resumeTime } from "../state.js";
import { t, onLangChange } from "../i18n.js";
import { APP_VERSION } from "../constants.js";
import {
  getRankingApiUrl,
  getPlayerName,
  setPlayerName,
  submitScore,
} from "../ranking-client.js";

const $ = (sel, root = document) => root.querySelector(sel);

const RANKING_REGULATION = "mvp-day3";

// 重複登録防止
let _bound = false;
// 直近の勝敗結果 (= 言語切替時の再描画に使う)
let _lastResult = null; // { battle, winner, score }

// ============================================================
// Score 計算 (= 純粋関数)
// ============================================================

/**
 * @param {object} battle - state.battle
 * @param {"player"|"cpu"} winner
 * @returns {number}
 */
export function computeScore(battle, winner) {
  const turns = battle.turnNumber;
  const myHp = battle.player.masterHp;
  const oppHp = battle.cpu.masterHp;

  if (winner === "player") {
    // 勝利: 早く + 高 HP で勝つほど高得点 (= フロア 100、 上限なし)
    return Math.max(100, 2000 + myHp * 100 - turns * 50);
  }
  // 敗北: 長く粘る + 与ダメ で慰めスコア (= フロア 0、 上限 800)
  const damageDealt = Math.max(0, 10 - oppHp);
  return Math.min(800, turns * 30 + damageDealt * 50);
}

// ============================================================
// 表示 / 閉じる
// ============================================================

/**
 * 勝敗画面を pop up する
 * @param {object} battle
 * @param {"player"|"cpu"} winner
 */
export function showGameOverScreen(battle, winner) {
  const score = computeScore(battle, winner);
  _lastResult = { battle, winner, score };

  renderGameOverContent();
  bindGameOverListeners();

  pauseTime();
  $("#gameOverOverlay")?.classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

/**
 * オーバーレイを閉じる (= 内部用、 returnToTitle / 他から呼ぶ)
 */
function closeGameOverScreen() {
  $("#gameOverOverlay")?.classList.add("hidden");
  document.body.style.overflow = "";
  resumeTime();
}

/**
 * オーバーレイ内の DOM を _lastResult から更新
 * (= 言語切替時に再描画するために独立関数化)
 */
function renderGameOverContent() {
  if (!_lastResult) return;
  const { battle, winner, score } = _lastResult;

  const titleEl = $("#gameOverTitle");
  titleEl.classList.remove("is-victory", "is-defeat");
  if (winner === "player") {
    titleEl.textContent = t("gameover.title.victory");
    titleEl.classList.add("is-victory");
  } else {
    titleEl.textContent = t("gameover.title.defeat");
    titleEl.classList.add("is-defeat");
  }

  $("#gameOverScore").textContent = String(score);
  $("#goStatTurns").textContent = String(battle.turnNumber);
  $("#goStatMyHp").textContent = String(battle.player.masterHp);
  $("#goStatOppHp").textContent = String(battle.cpu.masterHp);

  // Name input prefill
  const nameInput = $("#goNameInput");
  if (nameInput && !nameInput.value) {
    const stored = getPlayerName();
    nameInput.value = stored === "anonymous" ? "" : stored;
  }

  // Submit ボタン disabled / 「未設定」 表示
  const submitBtn = $("#btnSubmitRanking");
  const status = $("#goSubmitStatus");
  status.classList.remove("is-ok", "is-fail");
  if (getRankingApiUrl()) {
    submitBtn.disabled = false;
    submitBtn.textContent = t("gameover.submit");
    status.textContent = "";
  } else {
    submitBtn.disabled = true;
    submitBtn.textContent = t("gameover.submit");
    status.textContent = t("gameover.noApi");
  }
}

// ============================================================
// イベント結線
// ============================================================

function bindGameOverListeners() {
  if (_bound) return;
  _bound = true;

  $("#btnSubmitRanking")?.addEventListener("click", triggerSubmitRanking);
  $("#btnReturnToTitle")?.addEventListener("click", triggerReturnToTitle);
  onLangChange(() => {
    // 開いている時のみ再描画 (= 閉じている時は次回 show で描画される)
    if (!$("#gameOverOverlay")?.classList.contains("hidden")) {
      renderGameOverContent();
    }
  });
}

/**
 * ランキング送信 (= name 保存 → submitScore → status 表示)
 */
export async function triggerSubmitRanking() {
  if (!_lastResult) return;
  const url = getRankingApiUrl();
  if (!url) return; // disabled 状態の保険

  const btn = $("#btnSubmitRanking");
  const status = $("#goSubmitStatus");
  const nameInput = $("#goNameInput");
  const name = (nameInput?.value || "").trim();
  if (name) setPlayerName(name);

  btn.disabled = true;
  status.classList.remove("is-ok", "is-fail");
  status.textContent = t("gameover.submitting");

  const result = await submitScore({
    playerName: getPlayerName(),
    score: _lastResult.score,
    version: APP_VERSION,
    regulation: RANKING_REGULATION,
  });

  btn.disabled = false;
  if (result.ok) {
    status.textContent = t("gameover.submitOk");
    status.classList.add("is-ok");
  } else {
    const tmpl = t("gameover.submitFail");
    status.textContent = tmpl.replace("{err}", result.error || "unknown");
    status.classList.add("is-fail");
  }
}

/**
 * タイトル復帰 (= state.battle = null + battle screen 非表示 + title 表示)
 */
export function triggerReturnToTitle() {
  closeGameOverScreen();

  // battle screen を非表示
  $("#battleScreen")?.classList.add("hidden");
  // app frame も非表示にして title に戻る (= dismissTitle の逆)
  $("#app")?.classList.add("hidden");
  $("#titleScreen")?.classList.remove("hidden");

  // battle state クリア
  state.battle = null;
  // submit status をクリアし、 次回バトル用に名前入力をリセット (= prefill は次回 show で再評価)
  const status = $("#goSubmitStatus");
  if (status) {
    status.textContent = "";
    status.classList.remove("is-ok", "is-fail");
  }
  _lastResult = null;
}
