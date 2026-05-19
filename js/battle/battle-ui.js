// ============================================================
// battle/battle-ui.js — state.battle を DOM に描画 + タップ操作
// ============================================================

import { state } from "../state.js";
import { t, getLang, onLangChange } from "../i18n.js";
import { getHeroDef } from "./cards.js";
import {
  endTurn,
  canSummon,
  summonHero,
  canAttack,
  getValidAttackTargets,
  performAttack,
  checkVictory,
} from "./battle-logic.js";
import {
  attachSprite,
  triggerAttackAnim,
  triggerHitAnim,
  triggerSummonAnim,
} from "./sprite.js";

// ============================================================
// DOM helpers
// ============================================================
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ============================================================
// UI state machine
// ============================================================
let _uiState = "idle"; // "idle" | "summoning" | "attacking"
let _selectedHandIdx = -1;
let _selectedAttackerSlot = null;
let _listenersBound = false;

function resetUiState() {
  _uiState = "idle";
  _selectedHandIdx = -1;
  _selectedAttackerSlot = null;
}

// ============================================================
// i18n helpers
// ============================================================
function nameOf(card) {
  if (!card || !card.name) return "";
  const lang = getLang();
  return card.name[lang] || card.name.ja || card.id || "";
}

function fillTemplate(text, vars) {
  return text.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? vars[k] : `{${k}}`));
}

// ============================================================
// Render
// ============================================================
export function renderBattle() {
  const battle = state.battle;
  if (!battle) return;

  // --- CPU info ---
  $("#cpuHpValue").textContent = battle.cpu.masterHp;
  $("#cpuStonesValue").textContent = battle.cpu.stones;
  $("#cpuHandCount").textContent = battle.cpu.hand.length;

  // --- CPU hand back ---
  const cpuHandBack = $("#cpuHandBack");
  cpuHandBack.innerHTML = "";
  for (let i = 0; i < battle.cpu.hand.length; i++) {
    const el = document.createElement("div");
    el.className = "hand-card-back";
    cpuHandBack.appendChild(el);
  }

  // --- Fields ---
  renderFieldSlot("#cpuFieldBack",   battle.cpu.field.back,    battle);
  renderFieldSlot("#cpuFieldFront",  battle.cpu.field.front,   battle);
  renderFieldSlot("#playerFieldFront", battle.player.field.front, battle);
  renderFieldSlot("#playerFieldBack",  battle.player.field.back,  battle);

  // --- Player info ---
  $("#playerHpValue").textContent = battle.player.masterHp;
  $("#playerStonesValue").textContent = battle.player.stones;

  // --- Player hand ---
  renderPlayerHand(battle);

  // --- Divider ---
  renderDivider(battle);

  // --- Highlights (= field-slot / master-attack-target の追加) ---
  applyHighlights(battle);

  // --- Hint text ---
  renderHint(battle);

  // --- CPU thinking overlay ---
  const screen = $("#battleScreen");
  if (screen) {
    screen.classList.toggle("is-cpu-thinking",
      battle.phase === "cpuThinking" || (battle.turn === "cpu" && battle.phase === "action"));
  }
}

function renderFieldSlot(selector, unit, battle) {
  const el = $(selector);
  if (!el) return;
  el.classList.remove(
    "field-slot--empty",
    "field-slot--occupied",
    "field-slot--sick",
    "field-slot--highlight-target",
    "field-slot--highlight-source"
  );
  if (!unit) {
    el.classList.add("field-slot--empty");
    el.innerHTML = `<span class="field-slot__placeholder">${t("battle.slot.empty")}</span>`;
    return;
  }
  el.classList.add("field-slot--occupied");
  if (unit.summoningSick) el.classList.add("field-slot--sick");

  const def = getHeroDef(battle.cardDb, unit.cardId);
  const portraitUrl = def?.portraitUrl || "";
  const displayName = nameOf(def);
  const side = el.dataset.side;

  el.innerHTML = `
    <div class="field-slot__portrait" style="background-image: url('${portraitUrl}')"></div>
    <div class="field-slot__name">${escapeHtml(displayName)}</div>
    <div class="field-slot__stats">
      <span class="hp">HP ${unit.currentHp}/${unit.maxHp}</span>
      <span class="atk">ATK ${unit.atk}</span>
    </div>
  `;

  attachSprite(el.querySelector(".field-slot__portrait"), { side });
}

function renderPlayerHand(battle) {
  const root = $("#playerHand");
  root.innerHTML = "";
  const playerCanAct = battle.turn === "player" && battle.phase === "action";

  for (let i = 0; i < battle.player.hand.length; i++) {
    const cardId = battle.player.hand[i];
    const def = getHeroDef(battle.cardDb, cardId);
    if (!def) continue;

    const summonCheck = canSummon(battle.player, cardId, battle.cardDb, def.row);
    const disabled = !playerCanAct || !summonCheck.ok;

    const el = document.createElement("div");
    el.className = "hand-card";
    if (disabled) el.classList.add("hand-card--disabled");
    if (_uiState === "summoning" && i === _selectedHandIdx) el.classList.add("hand-card--selected");
    el.dataset.handIdx = String(i);
    el.dataset.cardId = cardId;

    el.innerHTML = `
      <div class="hand-card__portrait" style="background-image: url('${def.portraitUrl}')"></div>
      <div class="hand-card__name">${escapeHtml(nameOf(def))}</div>
      <div class="hand-card__row">
        <span class="hand-card__cost">${def.cost}</span>
        <span class="hand-card__atkhp">${def.atk}/${def.hp}</span>
      </div>
    `;
    root.appendChild(el);
  }
}

function renderDivider(battle) {
  const turnLabel = battle.phase === "gameOver"
    ? t("battle.phase.gameOver")
    : (battle.turn === "player" ? t("battle.turn.player") : t("battle.turn.cpu"));
  $("#battleTurnLabel").textContent = `T${battle.turnNumber} — ${turnLabel}`;

  let phaseLabel = "";
  if (battle.phase === "cpuThinking") phaseLabel = t("battle.phase.cpuThinking");
  else if (battle.phase === "action") phaseLabel = t("battle.phase.action");
  $("#battlePhaseLabel").textContent = phaseLabel;

  const btn = $("#btnEndTurn");
  btn.disabled = !(battle.turn === "player" && battle.phase === "action");
}

function applyHighlights(battle) {
  // Clear existing target highlights + master target
  $$(".field-slot--highlight-target, .field-slot--highlight-source").forEach((el) => {
    el.classList.remove("field-slot--highlight-target", "field-slot--highlight-source");
  });
  $$(".master-attack-target").forEach((el) => el.remove());

  if (battle.turn !== "player" || battle.phase !== "action") return;

  if (_uiState === "summoning") {
    const cardId = battle.player.hand[_selectedHandIdx];
    const def = getHeroDef(battle.cardDb, cardId);
    if (def) {
      const slot = battle.player.field[def.row] === null
        ? $(`#playerField${capitalize(def.row)}`)
        : null;
      if (slot) slot.classList.add("field-slot--highlight-target");
    }
  }

  if (_uiState === "attacking") {
    const srcEl = $(`#playerField${capitalize(_selectedAttackerSlot)}`);
    if (srcEl) srcEl.classList.add("field-slot--highlight-source");

    const targets = getValidAttackTargets(battle.cpu);
    for (const tg of targets) {
      if (tg === "master") {
        const cpuSide = $(".battle-side--cpu");
        if (cpuSide) {
          const btn = document.createElement("div");
          btn.className = "master-attack-target master-attack-target--highlight";
          btn.dataset.targetMaster = "1";
          btn.textContent = t("battle.attackTarget.master");
          cpuSide.insertBefore(btn, cpuSide.firstChild);
        }
      } else {
        const el = $(`#cpuField${capitalize(tg)}`);
        if (el) el.classList.add("field-slot--highlight-target");
      }
    }
  }
}

function renderHint(battle) {
  const el = $("#battleHint");
  if (!el) return;
  el.classList.remove("battle-hint--victory", "battle-hint--defeat");

  if (battle.phase === "gameOver") {
    if (battle.winner === "player") {
      el.textContent = t("battle.hint.victory");
      el.classList.add("battle-hint--victory");
    } else {
      el.textContent = t("battle.hint.defeat");
      el.classList.add("battle-hint--defeat");
    }
    return;
  }
  if (battle.turn === "cpu" || battle.phase === "cpuThinking") {
    el.textContent = t("battle.hint.cpuTurn");
    return;
  }

  if (_uiState === "summoning") {
    const cardId = battle.player.hand[_selectedHandIdx];
    const def = getHeroDef(battle.cardDb, cardId);
    const rowLabel = def ? t(`battle.row.${def.row}`) : "";
    el.textContent = fillTemplate(t("battle.hint.summoning"), { row: rowLabel });
  } else if (_uiState === "attacking") {
    el.textContent = t("battle.hint.attacking");
  } else {
    el.textContent = t("battle.hint.idle");
  }
}

// ============================================================
// Event handlers
// ============================================================
export function setupBattleUiEventListeners() {
  if (_listenersBound) return;
  _listenersBound = true;

  document.addEventListener("click", handleClick);
  $("#btnEndTurn")?.addEventListener("click", onEndTurnClick);
  onLangChange(() => renderBattle());
}

function handleClick(ev) {
  const battle = state.battle;
  if (!battle) return;
  if (battle.turn !== "player" || battle.phase !== "action") return;

  const handCardEl = ev.target.closest(".hand-card");
  if (handCardEl && handCardEl.closest("#playerHand")) {
    onHandCardClick(handCardEl);
    return;
  }

  const playerSlot = ev.target.closest(".field-slot[data-side='player']");
  if (playerSlot) {
    onPlayerSlotClick(playerSlot);
    return;
  }

  if (_uiState === "attacking") {
    const cpuSlot = ev.target.closest(".field-slot[data-side='cpu']");
    if (cpuSlot && cpuSlot.classList.contains("field-slot--highlight-target")) {
      onAttackTargetClick(cpuSlot.dataset.row);
      return;
    }
    const masterTarget = ev.target.closest(".master-attack-target");
    if (masterTarget) {
      onAttackTargetClick("master");
      return;
    }
  }

  if (ev.target.closest("#btnEndTurn")) return;

  if (_uiState !== "idle") {
    resetUiState();
    renderBattle();
  }
}

function onHandCardClick(el) {
  const idx = Number(el.dataset.handIdx);
  if (el.classList.contains("hand-card--disabled")) {
    resetUiState();
    renderBattle();
    return;
  }
  if (_uiState === "summoning" && _selectedHandIdx === idx) {
    resetUiState();
  } else {
    _uiState = "summoning";
    _selectedHandIdx = idx;
  }
  renderBattle();
}

function onPlayerSlotClick(slotEl) {
  const battle = state.battle;
  const row = slotEl.dataset.row;

  if (_uiState === "summoning") {
    const cardId = battle.player.hand[_selectedHandIdx];
    const def = getHeroDef(battle.cardDb, cardId);
    let summoned = false;
    if (def && def.row === row) {
      try {
        summonHero(battle.player, cardId, battle.cardDb, row);
        summoned = true;
      } catch (e) {
        console.warn("[battle-ui] summon failed:", e.message);
      }
    }
    resetUiState();
    renderBattle();
    if (summoned) {
      const newPortrait = $(`#playerField${capitalize(row)} .field-slot__portrait`);
      triggerSummonAnim(newPortrait);
    }
    return;
  }

  if (_uiState === "attacking" && _selectedAttackerSlot === row) {
    resetUiState();
    renderBattle();
    return;
  }

  const unit = battle.player.field[row];
  if (unit && canAttack(unit)) {
    _uiState = "attacking";
    _selectedAttackerSlot = row;
    renderBattle();
  }
}

async function onAttackTargetClick(targetSlot) {
  const battle = state.battle;
  const attackerSlot = _selectedAttackerSlot;

  const attackerEl = $(`#playerField${capitalize(attackerSlot)} .field-slot__portrait`);
  const targetEl = targetSlot === "master"
    ? $(".battle-side--cpu .battle-side__info")
    : $(`#cpuField${capitalize(targetSlot)} .field-slot__portrait`);

  triggerAttackAnim(attackerEl, "player");
  await delay(180);

  try {
    performAttack(battle.player, battle.cpu, attackerSlot, targetSlot);
  } catch (e) {
    console.warn("[battle-ui] attack failed:", e.message);
    resetUiState();
    renderBattle();
    return;
  }

  if (targetEl) triggerHitAnim(targetEl);
  await delay(360);

  resetUiState();

  const winner = checkVictory(battle);
  if (winner) {
    finishBattle(winner);
    return;
  }
  renderBattle();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function onEndTurnClick() {
  const battle = state.battle;
  if (!battle) return;
  if (battle.turn !== "player" || battle.phase !== "action") return;

  resetUiState();
  endTurn(battle);
  renderBattle();

  const { runCpuTurn } = await import("./cpu-turn.js");
  await runCpuTurn(renderBattle, finishBattle);
}

function finishBattle(winner) {
  const battle = state.battle;
  battle.phase = "gameOver";
  battle.winner = winner;
  renderBattle();
  // 勝敗オーバーレイを表示 (= SPEC-107)
  import("./game-over.js").then(({ showGameOverScreen }) => {
    showGameOverScreen(battle, winner);
  });
}

// ============================================================
// Screen lifecycle
// ============================================================
export function enterBattleScreen() {
  $("#battleScreen")?.classList.remove("hidden");
  $("#stagePlaceholder")?.classList.add("hidden");
  setupBattleUiEventListeners();
  renderBattle();
}

export function exitBattleScreen() {
  $("#battleScreen")?.classList.add("hidden");
  $("#stagePlaceholder")?.classList.remove("hidden");
}

// ============================================================
// Utilities
// ============================================================
function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
