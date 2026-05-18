// ============================================================
// main.js — エントリポイント
// ============================================================

import { state, pauseTime, resumeTime } from "./state.js";
import { initI18n, setLang, getLang, applyDataI18n } from "./i18n.js";
import {
  TICK_INTERVAL_MS,
  SECONDS_PER_WEEK,
  WEEKS_PER_MONTH,
  MONTHS_PER_YEAR,
} from "./constants.js";

// ============================================================
// DOM helpers
// ============================================================
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ============================================================
// Init
// ============================================================
async function init() {
  pauseTime();   // ← 起動 splash 中は時間停止

  await initI18n();

  // ロード完了 → splash dismiss
  $("#splash")?.classList.add("hidden");
  $("#titleScreen")?.classList.remove("hidden");

  resumeTime();   // ← splash 終了

  setupTitleScreen();
  setupHelpOverlay();
  setupLangToggle();

  // タイトル画面表示中は時間が進むが、 onTick は state.activeXxx が無いので何も起きない
  startTimeLoop();
}

// ============================================================
// Title screen
// ============================================================
function setupTitleScreen() {
  $("#btnPressStart")?.addEventListener("click", dismissTitle);
}

function dismissTitle() {
  $("#titleScreen")?.classList.add("hidden");
  $("#app")?.classList.remove("hidden");
  // BGM 開始は audio.js の startBgm をここで呼ぶ
  // import("./audio.js").then(({ startBgm }) => startBgm("Audio/bgm_home.mp3"));
}

// ============================================================
// Lang toggle
// ============================================================
function setupLangToggle() {
  // タイトル画面の lang toggle
  $("#langToggle")?.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-lang]");
    if (!btn) return;
    setLang(btn.getAttribute("data-lang"));
    refreshLangButtonState();
  });
  refreshLangButtonState();

  // ヘッダーボタン (= 1 クリックで toggle)
  $("#btnLangToggle")?.addEventListener("click", () => {
    setLang(getLang() === "en" ? "ja" : "en");
    refreshLangButtonState();
  });
}

function refreshLangButtonState() {
  $$(".lang-btn").forEach((b) => {
    b.classList.toggle(
      "lang-btn--active",
      b.getAttribute("data-lang") === getLang()
    );
  });
}

// ============================================================
// Help overlay
// ============================================================
function setupHelpOverlay() {
  const overlay = $("#helpOverlay");
  if (!overlay) return;

  $("#btnHelpOpen")?.addEventListener("click", openHelp);
  $("#btnHelpClose")?.addEventListener("click", closeHelp);
  overlay.addEventListener("click", (e) => {
    if (e.target.id === "helpOverlay") closeHelp();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !overlay.classList.contains("hidden")) {
      closeHelp();
    }
  });
}

function openHelp() {
  pauseTime();
  $("#helpOverlay")?.classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

function closeHelp() {
  $("#helpOverlay")?.classList.add("hidden");
  document.body.style.overflow = "";
  resumeTime();
}

// ============================================================
// Time loop
// ============================================================
let _tickHandle = null;

function startTimeLoop() {
  if (_tickHandle) return;
  _tickHandle = setInterval(onTick, currentTickInterval());
}

function stopTimeLoop() {
  if (_tickHandle) {
    clearInterval(_tickHandle);
    _tickHandle = null;
  }
}

function currentTickInterval() {
  if (state.timeSpeed20x) return Math.round(TICK_INTERVAL_MS / 20);
  if (state.timeSpeed2x) return Math.round(TICK_INTERVAL_MS / 2);
  return TICK_INTERVAL_MS;
}

function onTick() {
  if (state.pauseFlags > 0) return;
  state.tickCount++;
  state.weekProgress++;
  if (state.weekProgress >= SECONDS_PER_WEEK) advanceWeek();

  // ... 各 feature の tick はここから呼ぶ ...
  // tickActiveCraft();
  // tickActiveQuest();

  renderHeader();
}

function advanceWeek() {
  state.weekProgress = 0;
  state.week++;
  if (state.week > WEEKS_PER_MONTH) {
    state.week = 1;
    state.month++;
    if (state.month > MONTHS_PER_YEAR) {
      state.month = 1;
      state.year++;
    }
  }
  // checkMonthlyEvents() をここから呼ぶ
}

function renderHeader() {
  const el = $("#dateLabel");
  if (el) el.textContent = `${state.year} 年 ${state.month} 月 ${state.week} 週`;
}

// ============================================================
// Boot
// ============================================================
window.addEventListener("DOMContentLoaded", () => {
  init().catch((e) => console.error("init failed", e));
});

// ============================================================
// Global で覗くため (= デバッグ用)
// ============================================================
if (typeof window !== "undefined") {
  window.__state = state;
  window.__pauseTime = pauseTime;
  window.__resumeTime = resumeTime;

  // SPEC-102 smoke test (= console から手動実行)
  window.__testBattle = async function __testBattle() {
    const { initBattle, INITIAL_MASTER_HP, MAX_STONES } = await import("./battle/battle-state.js");
    const { drawCard, shuffleDeck, isDeckEmpty } = await import("./battle/deck.js");
    const { getHeroDef } = await import("./battle/cards.js");

    const ids = ["mch_1001", "mch_1002", "mch_1003"];
    const battle = await initBattle(ids.slice(), ids.slice());
    console.log("[testBattle] battle:", battle);
    console.log("[testBattle] player.deck:", battle.player.deck);
    console.log("[testBattle] cpu.deck:", battle.cpu.deck);

    if (battle.player.deck.length !== 3) throw new Error("player.deck.length !== 3");
    if (battle.cpu.deck.length !== 3) throw new Error("cpu.deck.length !== 3");
    if (battle.player.masterHp !== INITIAL_MASTER_HP) throw new Error("masterHp !== 10");

    const drawn = drawCard(battle.player);
    console.log("[testBattle] drew:", drawn, "→ hand:", battle.player.hand, "deck:", battle.player.deck);
    if (battle.player.hand.length !== 1) throw new Error("hand.length !== 1 after draw");
    if (battle.player.deck.length !== 2) throw new Error("deck.length !== 2 after draw");

    const def = getHeroDef(battle.cardDb, drawn);
    console.log("[testBattle] hero def:", def?.name, "cost:", def?.cost, "hp:", def?.hp, "atk:", def?.atk);
    if (!def) throw new Error(`hero def not found for ${drawn}`);

    // shuffle 多様性のスポットチェック
    const seen = new Set();
    for (let i = 0; i < 30; i++) {
      const d = ids.slice();
      shuffleDeck(d);
      seen.add(d.join(","));
    }
    console.log("[testBattle] shuffle permutations seen:", seen.size, "/ 30");
    if (seen.size < 2) console.warn("[testBattle] shuffle 多様性が低い (= 30 回で 2 種未満)");

    console.log("[testBattle] ok");
    return battle;
  };
}
