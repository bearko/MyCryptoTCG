// ============================================================
// battle/activity-report.js — リザルト画面の雛形 (= 活動レポート)
// ============================================================
//
// 派生プロジェクトで「全ステージクリア時のリザルト」 や 「ゲームオーバー時の
// スコア表示」 を作るときの **雛形**。 mycryptosurvivor SPEC-038 で確立した
// 「アイコンタイル + 巨大スコア」 レイアウトを CSS (= `css/components.css` の
// `.report-*`) とセットで提供。
//
// テンプレートには未だ STAGE_TABLE / extensions.js / heroes.js / formatElapsed
// 等が存在しないため、 本ファイルは **DOM 結線と layout 流儀の足場** だけを示す。
// 派生では:
//   - `_renderReport()` 内の placeholder 部分を実データで差し替え
//   - `computeScore()` の式をゲーム性に合わせて調整
//   - 画像 src を `heroImg(...)` / `extTierImg(...)` 等の自前 helper に差し替え
//
// pauseFlags 不変条件: open で pauseTime + 1、 close (= retry/閉じる) で resumeTime + 1。

import { state, pauseTime, resumeTime } from "../state.js";
import { APP_VERSION } from "../constants.js";
import { t, tpl, onLangChange } from "../i18n.js";
import {
  getPlayerName, setPlayerName, submitScore, getRankingApiUrl,
} from "../ranking-client.js";

let _wired = false;

/**
 * 活動レポート modal を開く (= 全ステージ clear / クリア達成時を想定)。
 * 失敗 (= HP 0) 路線で別 modal を出したい派生は `triggerGameOver()` を別途用意。
 *
 * @param {Object} [runSummary] - 派生で `state.run` 相当の集計オブジェクトを渡す
 */
export function triggerActivityReport(runSummary) {
  pauseTime();
  _wireOnce();
  _renderReport(runSummary);
  document.getElementById("activityReportModal")?.classList.remove("hidden");
}

function _wireOnce() {
  if (_wired) return;
  _wired = true;
  document.getElementById("activityReportRetry")
    ?.addEventListener("click", _onRetryClick);
  document.getElementById("activityReportSubmit")
    ?.addEventListener("click", _onSubmitClick);
  onLangChange(() => {
    if (!document.getElementById("activityReportModal")?.classList.contains("hidden")) {
      _renderReport(state.run);
    }
  });
}

function _onRetryClick() {
  document.getElementById("activityReportModal")?.classList.add("hidden");
  resumeTime();
  // 派生で battle restart hook を呼ぶ:
  //   const m = await import("./index.js");
  //   m.startBattle(state.ownedHero);
}

async function _onSubmitClick() {
  const btn   = document.getElementById("activityReportSubmit");
  const input = document.getElementById("activityReportName");
  const msg   = document.getElementById("activityReportMsg");
  if (!btn || !input || !msg) return;
  // 空欄ならランキングクライアント側で "anonymous" にフォールバック (= SPEC-038)
  const name = (input.value || "").trim().slice(0, 30) || getPlayerName();
  setPlayerName(name === "anonymous" ? "" : name);
  btn.disabled = true;
  msg.textContent = t("gameover.submitting", "Submitting…");

  const run = state.run || {};
  const score    = computeScore(run);
  const totalSec = Math.round((run.totalElapsedMs ?? 0) / 1000);

  const result = await submitScore({
    playerName: name,
    score,
    level:      run.bestLevel    ?? 1,
    kills:      run.totalKills   ?? 0,
    hero:       _heroName(),
    faction:    state.ownedHero?.faction ?? null,
    version:    APP_VERSION,
    elapsedSec: totalSec,
    // 派生で別レギュレーション (= ハードモード等) を実装する場合に拡張:
    regulation:    run.regulation    ?? "NORMAL",
    regulationMul: run.regulationMul ?? 1.0,
  });
  if (result.ok) {
    msg.textContent = t("gameover.submitOk", "Submitted!");
  } else {
    btn.disabled = false;
    const errTpl = t("gameover.submitFail", "Submit failed: {err}");
    msg.textContent = tpl(errTpl, { err: result.error || "?" });
  }
}

function _heroName() {
  const h = state.ownedHero;
  if (!h) return null;
  const n = h.name;
  if (typeof n === "string") return n;
  return n?.ja ?? n?.en ?? null;
}

/**
 * 活動レポートのスコア算出 (= 雛形)。 派生で式を調整すること。
 *   score = 撃破数*100 + 最高 Lv*500 + 取得 ext 数*300 + 速度ボーナス + クリア基本 5000
 */
export function computeScore(run) {
  const kills = run.totalKills ?? 0;
  const sec   = (run.totalElapsedMs ?? 0) / 1000;
  const extIds = new Set();
  let bestLevel = 1;
  for (const s of (run.stages ?? [])) {
    if ((s.level ?? 1) > bestLevel) bestLevel = s.level;
    for (const o of (s.ownedExtensions ?? [])) extIds.add(String(o.extId));
  }
  const speedBonus = Math.max(0, 60000 - Math.round(sec * 50));
  const baseScore  = kills * 100 + bestLevel * 500 + extIds.size * 300 + speedBonus + 5000;
  const regMul     = run.regulationMul ?? 1.0;
  return Math.round(baseScore * regMul);
}

/**
 * リザルトの DOM 描画。 アイコンタイル + 巨大スコアの構造 (= SPEC-038 流儀)。
 * 派生で `heroImg(h.heroId)` / `extTierImg(ext, lv)` / `getTierName(...)` 等を
 * 差し込み、 stage / ext の placeholder 部を実データで埋める。
 */
function _renderReport(run) {
  run = run ?? state.run ?? {};

  const titleEl = document.getElementById("activityReportTitle");
  if (titleEl) titleEl.textContent = t("report.title", "活動レポート");

  // --- ヒーロー帯 (= アイコン + 名前、 派閥カラー border) ---
  const heroEl = document.getElementById("activityReportHero");
  if (heroEl) {
    const h = state.ownedHero;
    const name    = _heroName() ?? "—";
    const faction = h?.faction ?? "";
    const heroSrc = h?.imgUrl ?? "";   // 派生で heroImg(h.heroId) 等に差し替え
    const imgHtml = heroSrc
      ? `<img class="report-hero__portrait" src="${escapeAttr(heroSrc)}" alt="${escapeAttr(name)}" loading="lazy" ` +
        ` onerror="this.classList.add('report-hero__portrait--missing'); this.removeAttribute('src');" />`
      : `<div class="report-hero__portrait report-hero__portrait--missing"></div>`;
    heroEl.innerHTML =
      `<div class="report-hero__inner" data-faction="${escapeAttr(faction)}">` +
      `  ${imgHtml}` +
      `  <span class="report-hero__name">${escapeHtml(name)}</span>` +
      `</div>`;
  }

  // --- ステージカード (= 各ステージのアイコンタイル) ---
  const stagesEl = document.getElementById("activityReportStages");
  if (stagesEl) {
    stagesEl.innerHTML = "";
    for (const s of (run.stages ?? [])) {
      const card = document.createElement("div");
      card.className = "report-stage";
      const stageName = s.nameKey ? t(s.nameKey, s.nameKey) : (s.name ?? "Stage");
      const time      = _formatElapsed(Math.round((s.elapsedMs ?? 0) / 1000));
      const extTiles  = (s.ownedExtensions ?? []).map(o => {
        const altName = o.name ?? `#${o.extId}`;
        const src     = o.iconUrl ?? "";   // 派生で extTierImg(ext, o.level) 等
        const imgHtml = src
          ? `<img class="report-ext__icon" src="${escapeAttr(src)}" alt="${escapeAttr(altName)}" loading="lazy" ` +
            ` onerror="this.classList.add('report-ext__icon--missing'); this.removeAttribute('src');" />`
          : `<div class="report-ext__icon report-ext__icon--missing"></div>`;
        return `<div class="report-ext" title="${escapeAttr(altName)}">` +
               `  ${imgHtml}` +
               `  <span class="report-ext__lv">Lv.${o.level | 0}</span>` +
               `</div>`;
      }).join("");
      card.innerHTML =
        `<header class="report-stage__head">` +
        `  <span class="report-stage__name">${escapeHtml(stageName)}</span>` +
        `  <span class="report-stage__stats">${escapeHtml(time)} / ${s.kills | 0} / Lv.${s.level | 0}</span>` +
        `</header>` +
        `<div class="report-stage__exts">${extTiles || `<span class="report-ext--empty">${escapeHtml(t("report.emptyExts", "—"))}</span>`}</div>`;
      stagesEl.appendChild(card);
    }
  }

  // --- 総合スタッツ + 巨大スコア ---
  const totalsEl = document.getElementById("activityReportTotals");
  if (totalsEl) {
    const totalSec = Math.round((run.totalElapsedMs ?? 0) / 1000);
    const score    = computeScore(run);
    const regLabel = (run.regulation === "ABSOLUTE")
      ? `ABSOLUTE x${(run.regulationMul ?? 1).toFixed(2)}`
      : `NORMAL x1.00`;
    totalsEl.innerHTML =
      `<div class="report-meta-row">` +
      `  <span class="report-meta">${escapeHtml(regLabel)}</span>` +
      `  <span class="report-meta">${escapeHtml(_formatElapsed(totalSec))}</span>` +
      `  <span class="report-meta">${run.totalKills | 0}</span>` +
      `</div>` +
      `<div class="report-score-big">${(score | 0).toLocaleString()}</div>` +
      `<div class="report-score-label">${escapeHtml(t("report.scoreLabel", "SCORE"))}</div>`;
  }

  // --- ranking 送信 + リトライボタン ---
  const submitBtn = document.getElementById("activityReportSubmit");
  const msg       = document.getElementById("activityReportMsg");
  const noApi     = !getRankingApiUrl();
  if (submitBtn) {
    submitBtn.disabled    = noApi;
    submitBtn.textContent = t("gameover.submit", "ランキングに送信");
  }
  if (msg) msg.textContent = noApi ? t("gameover.noApi", "Ranking API not configured") : "";
  const retryBtn = document.getElementById("activityReportRetry");
  if (retryBtn) retryBtn.textContent = t("gameover.retry", "リトライ");
  const nameLabel = document.getElementById("activityReportNameLabel");
  if (nameLabel) nameLabel.textContent = t("gameover.namelabel", "プレイヤー名");
  // 空欄に anonymous をプリフィル (= SPEC-038 流儀、 ユーザーは編集可)
  const input = document.getElementById("activityReportName");
  if (input && !input.value) input.value = getPlayerName();
}

// 秒 → "M:SS" の最小整形 (= 派生で `formatElapsed` がある場合はそちらを優先)
function _formatElapsed(sec) {
  const s = Math.max(0, sec | 0);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function escapeAttr(s) { return escapeHtml(s); }
