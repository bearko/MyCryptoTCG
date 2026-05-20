// ============================================================
// battle/battle-ui.js — UX 再設計版 (= SPEC-108)
// 3 ゾーンレイアウト + 動詞型操作フロー (= 誰が → 何を → 誰に)
// ============================================================

import { state } from "../state.js";
import { t, getLang, onLangChange } from "../i18n.js";
import { getHeroDef } from "./cards.js";
import {
  endTurn,
  canSummon,
  summonHero,
  canAttack,
  performAttack,
  checkVictory,
} from "./battle-logic.js";
import {
  attachSprite,
  triggerAttackAnim,
  triggerHitAnim,
  triggerSummonAnim,
} from "./sprite.js";
import {
  BASIC_ATTACK_ID,
  getSkillDef,
  getSkillsFor,
  getValidTargetsForSkill,
  computeSkillPreview,
} from "./skill-registry.js";

// ============================================================
// DOM helpers
// ============================================================
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ============================================================
// UI state
// ============================================================
let _uiState = "idle"; // idle / summoning / actorSelected / skillSelected / targetPreview
let _selectedHandIdx = -1;
let _selectedActor = null;   // {side, slot} (= 「誰が」)
let _selectedSkill = null;   // SkillDef (= 「何を」)
let _previewTarget = null;   // {side, slot} (= 「誰に」 の 1st tap target)
let _viewingTarget = null;   // 詳細パネルに表示中の {side, slot} (= 任意)
let _listenersBound = false;

function resetChain() {
  _uiState = "idle";
  _selectedHandIdx = -1;
  _selectedActor = null;
  _selectedSkill = null;
  _previewTarget = null;
  // _viewingTarget は維持 (= ユーザーが詳細を見続けたいケース)
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
// Side / slot helpers
// ============================================================
function getUnitAt(battle, side, slot) {
  if (slot === "master") return null;
  return battle[side].field[slot];
}

function isAllyHeroActor(battle, side, slot) {
  if (side !== "player") return false;
  if (slot === "master") return false;
  const unit = battle[side].field[slot];
  return !!unit;
}

function actorCanAct(battle) {
  if (!_selectedActor) return false;
  const u = getUnitAt(battle, _selectedActor.side, _selectedActor.slot);
  return canAttack(u);
}

function sameTarget(a, b) {
  return a && b && a.side === b.side && a.slot === b.slot;
}

function isValidTargetForCurrentSkill(target) {
  if (!_selectedSkill || !_selectedActor) return false;
  const valid = getValidTargetsForSkill(state.battle, _selectedActor.side, _selectedActor.slot, _selectedSkill);
  return valid.some((v) => sameTarget(v, target));
}

// ============================================================
// Render entry
// ============================================================
export function renderBattle() {
  const battle = state.battle;
  if (!battle) return;

  renderInstrSlots(battle);
  renderSkillChooser(battle);
  renderPlayerHand(battle);
  renderBoardMeta(battle);
  renderBoardContent(battle);
  renderHint(battle);
  renderEndTurnButton(battle);

  const screen = $("#battleScreen");
  if (screen) {
    screen.classList.toggle("is-cpu-thinking",
      battle.phase === "cpuThinking" || (battle.turn === "cpu" && battle.phase === "action"));
  }
}

// ============================================================
// Render: instr-slots (= 敵 + 味方 × 3 枠)
// ============================================================
function renderInstrSlots(battle) {
  for (const side of ["cpu", "player"]) {
    for (const slot of ["back", "front", "master"]) {
      const el = $(`#instr${capitalize(side)}${capitalize(slot)}`);
      if (!el) continue;
      renderOneInstrSlot(el, battle, side, slot);
    }
  }
}

function renderOneInstrSlot(el, battle, side, slot) {
  // Clear state classes
  el.classList.remove(
    "instr-slot--empty",
    "instr-slot--occupied",
    "instr-slot--sick",
    "instr-slot--attacked",
    "instr-slot--player",
    "instr-slot--cpu",
    "instr-slot--selected-actor",
    "instr-slot--valid-target",
    "instr-slot--preview-target",
    "instr-slot--viewing",
    "is-friendly",
  );
  el.classList.add(side === "player" ? "instr-slot--player" : "instr-slot--cpu");

  // Master: special render (= always present)
  if (slot === "master") {
    const sideObj = battle[side];
    el.classList.add("instr-slot--occupied");
    el.innerHTML = `
      <div class="instr-slot__portrait"></div>
      <div class="instr-slot__name">${escapeHtml(t("instr.slot.master"))}</div>
      <div class="instr-slot__stats">
        <span class="hp">HP ${sideObj.masterHp}</span>
        <span class="stones">S ${sideObj.stones}</span>
      </div>
    `;
  } else {
    const unit = battle[side].field[slot];
    if (!unit) {
      el.classList.add("instr-slot--empty");
      el.setAttribute("data-empty-label", t("instr.slot.empty"));
      el.innerHTML = "";
    } else {
      el.classList.add("instr-slot--occupied");
      if (unit.summoningSick) el.classList.add("instr-slot--sick");
      if (unit.attackedThisTurn) el.classList.add("instr-slot--attacked");
      const def = getHeroDef(battle.cardDb, unit.cardId);
      const portraitUrl = def?.portraitUrl || "";
      el.innerHTML = `
        <div class="instr-slot__portrait" style="background-image: url('${portraitUrl}')"></div>
        <div class="instr-slot__name">${escapeHtml(nameOf(def))}</div>
        <div class="instr-slot__stats">
          <span class="hp">HP ${unit.currentHp}/${unit.maxHp}</span>
          <span class="atk">ATK ${unit.atk}</span>
        </div>
      `;
      const portraitEl = el.querySelector(".instr-slot__portrait");
      attachSprite(portraitEl, { side });
    }
  }

  // Highlights
  const target = { side, slot };
  if (_selectedActor && sameTarget(_selectedActor, target)) {
    el.classList.add("instr-slot--selected-actor");
  }
  if ((_uiState === "skillSelected" || _uiState === "targetPreview") && _selectedSkill) {
    if (isValidTargetForCurrentSkill(target)) {
      el.classList.add("instr-slot--valid-target");
      if (target.side === "player") el.classList.add("is-friendly");
    }
  }
  if (_uiState === "targetPreview" && _previewTarget && sameTarget(_previewTarget, target)) {
    el.classList.add("instr-slot--preview-target");
  }
  if (_viewingTarget && sameTarget(_viewingTarget, target) && !el.classList.contains("instr-slot--selected-actor")) {
    el.classList.add("instr-slot--viewing");
  }
}

// ============================================================
// Render: skill chooser
// ============================================================
function renderSkillChooser(battle) {
  const chooser = $("#skillChooser");
  const list = $("#skillChooserList");
  if (!chooser || !list) return;

  list.innerHTML = "";

  // ally hero が _selectedActor のとき表示
  if (!_selectedActor || _selectedActor.side !== "player" || _selectedActor.slot === "master") {
    chooser.classList.add("hidden");
    return;
  }
  const actorUnit = getUnitAt(battle, "player", _selectedActor.slot);
  if (!actorUnit) {
    chooser.classList.add("hidden");
    return;
  }
  chooser.classList.remove("hidden");

  const def = getHeroDef(battle.cardDb, actorUnit.cardId);
  const skills = getSkillsFor(def);

  for (const skill of skills) {
    const card = document.createElement("div");
    card.className = "skill-card";
    card.dataset.skillId = skill.id;

    const canAct = canAttack(actorUnit);
    const enoughStones = battle.player.stones >= skill.cost;
    const usable = skill.implemented && canAct && enoughStones;

    if (!usable) card.classList.add("skill-card--disabled");
    if (_selectedSkill && _selectedSkill.id === skill.id) card.classList.add("skill-card--selected");

    const kindLabel = skill.effectKind === "damage" ? "DMG"
      : skill.effectKind === "heal" ? "HEAL"
      : "BUFF";

    card.innerHTML = `
      <div class="skill-card__name">${escapeHtml(nameOf(skill))}</div>
      <div class="skill-card__meta">
        <span class="skill-card__cost">${skill.cost}</span>
        <span class="skill-card__kind">${kindLabel}</span>
      </div>
      ${skill.implemented ? "" : `<div class="skill-card__phase2">${escapeHtml(t("skill.phase2"))}</div>`}
    `;
    list.appendChild(card);
  }
}

// ============================================================
// Render: player hand (= footer)
// ============================================================
function renderPlayerHand(battle) {
  const root = $("#playerHand");
  if (!root) return;
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

// ============================================================
// Render: board meta + content
// ============================================================
function renderBoardMeta(battle) {
  const turnLabel = battle.phase === "gameOver"
    ? t("hint.gameOver")
    : (battle.turn === "player" ? t("battle.turn.player") : t("battle.turn.cpu"));
  $("#battleTurnLabel").textContent = `T${battle.turnNumber} — ${turnLabel}`;

  let phaseLabel = "";
  if (battle.phase === "cpuThinking") phaseLabel = t("battle.phase.cpuThinking");
  else if (battle.phase === "action") phaseLabel = t("battle.phase.action");
  $("#battlePhaseLabel").textContent = phaseLabel;
}

function renderBoardContent(battle) {
  const root = $("#boardContent");
  if (!root) return;
  root.innerHTML = "";

  if (battle.phase === "gameOver") {
    // 勝敗 overlay 側で表示するため、 board は空のまま
    return;
  }

  // targetPreview: HP before/after を最優先
  if (_uiState === "targetPreview" && _selectedSkill && _previewTarget) {
    renderTargetPreviewPanel(root, battle);
    return;
  }

  // skillSelected: skill range を表示 (= actor + skill 情報 + 範囲ヒント)
  if (_uiState === "skillSelected" && _selectedSkill && _selectedActor) {
    renderActorDetail(root, battle, _selectedActor);
    renderSkillInfoPanel(root, battle);
    return;
  }

  // actorSelected: actor 詳細だけ
  if (_uiState === "actorSelected" && _selectedActor) {
    renderActorDetail(root, battle, _selectedActor);
    return;
  }

  // summoning: 選択中の手札カード詳細
  if (_uiState === "summoning" && _selectedHandIdx >= 0) {
    renderHandCardDetail(root, battle);
    return;
  }

  // _viewingTarget が設定されていればそれを表示 (= view-only)
  if (_viewingTarget) {
    renderActorDetail(root, battle, _viewingTarget);
    return;
  }

  // 何もない → overview
  renderBoardOverview(root, battle);
}

function renderBoardOverview(root, battle) {
  const div = document.createElement("div");
  div.className = "board-overview";
  div.innerHTML = `
    <div>${escapeHtml(t("board.overview.title"))}</div>
    <div class="board-overview__summary">
      <div class="board-overview__side board-overview__side--cpu">
        <div>${escapeHtml(t("board.overview.cpuSide"))}</div>
        <strong>${battle.cpu.masterHp}</strong>
      </div>
      <div class="board-overview__side board-overview__side--player">
        <div>${escapeHtml(t("board.overview.playerSide"))}</div>
        <strong>${battle.player.masterHp}</strong>
      </div>
    </div>
  `;
  root.appendChild(div);
}

function renderActorDetail(root, battle, target) {
  const detail = document.createElement("div");
  detail.className = "board-detail";

  if (target.slot === "master") {
    const sideObj = battle[target.side];
    const sideLabel = target.side === "player"
      ? t("board.overview.playerSide")
      : t("board.overview.cpuSide");
    detail.innerHTML = `
      <div class="board-detail__portrait" style="background: radial-gradient(circle, ${
        target.side === "player" ? "var(--leviathan)" : "var(--ifrit)"
      }, var(--panel-2));"></div>
      <div class="board-detail__name">${escapeHtml(sideLabel)}</div>
      <div class="board-detail__stats">
        <span class="hp">${t("board.detail.hp")} ${sideObj.masterHp}</span>
        <span class="stones">${t("board.detail.stones")} ${sideObj.stones}</span>
      </div>
    `;
  } else {
    const unit = battle[target.side].field[target.slot];
    if (!unit) {
      detail.innerHTML = `<div class="board-detail__name">${escapeHtml(t("instr.slot.empty"))}</div>`;
    } else {
      const def = getHeroDef(battle.cardDb, unit.cardId);
      const statusItems = [];
      if (unit.summoningSick) {
        statusItems.push(`<span class="is-sick">${escapeHtml(t("board.detail.sick"))}</span>`);
      } else if (unit.attackedThisTurn) {
        statusItems.push(`<span class="is-attacked">${escapeHtml(t("board.detail.attacked"))}</span>`);
      }
      detail.innerHTML = `
        <div class="board-detail__portrait" style="background-image: url('${def?.portraitUrl || ""}')"></div>
        <div class="board-detail__name">${escapeHtml(nameOf(def))}</div>
        <div class="board-detail__stats">
          <span class="hp">${t("board.detail.hp")} ${unit.currentHp}/${unit.maxHp}</span>
          <span class="atk">${t("board.detail.atk")} ${unit.atk}</span>
        </div>
        ${statusItems.length ? `<div class="board-detail__status">${statusItems.join(" / ")}</div>` : ""}
      `;
    }
  }
  root.appendChild(detail);
}

function renderSkillInfoPanel(root, battle) {
  const info = document.createElement("div");
  info.className = "board-skill-info";
  info.innerHTML = `
    <div class="board-skill-info__name">${escapeHtml(nameOf(_selectedSkill))}</div>
    <div class="board-skill-info__meta">
      <span class="cost">${t("board.detail.stones")} ${_selectedSkill.cost}</span>
      <span class="kind">${escapeHtml(_selectedSkill.effectKind.toUpperCase())}</span>
    </div>
    <div class="board-skill-info__desc">${escapeHtml(nameOf({ name: _selectedSkill.description }))}</div>
    <div class="board-skill-info__desc"><em>${escapeHtml(t("board.skill.range"))}</em></div>
  `;
  root.appendChild(info);
}

function renderTargetPreviewPanel(root, battle) {
  const preview = computeSkillPreview(
    battle,
    _selectedActor.side,
    _selectedActor.slot,
    _selectedSkill,
    _previewTarget
  );

  const targetLabel = _previewTarget.slot === "master"
    ? (_previewTarget.side === "player" ? t("board.overview.playerSide") : t("board.overview.cpuSide"))
    : nameOf(getHeroDef(battle.cardDb, battle[_previewTarget.side].field[_previewTarget.slot]?.cardId));

  const panel = document.createElement("div");
  panel.className = "board-target-preview";
  panel.innerHTML = `
    <div class="board-detail__name">${escapeHtml(targetLabel)}</div>
    <div class="board-target-preview__hp">
      <span class="hp-before">${preview.hpBefore}</span>
      <span class="arrow">→</span>
      <span class="hp-after ${preview.isHeal ? "is-heal" : ""}">${preview.hpAfter}</span>
    </div>
    <div class="board-target-preview__damage ${preview.isHeal ? "is-heal" : ""}">
      ${preview.isHeal ? t("board.target.heal") : t("board.target.damage")} ${preview.damage}${preview.destroysTarget ? " (KO)" : ""}
    </div>
    <div class="board-target-preview__confirm">${escapeHtml(t("board.target.confirm"))}</div>
  `;
  root.appendChild(panel);
}

// ============================================================
// Render: hint + End Turn button
// ============================================================
function renderHint(battle) {
  const el = $("#battleHint");
  if (!el) return;
  el.classList.remove("battle-hint--victory", "battle-hint--defeat");

  if (battle.phase === "gameOver") {
    if (battle.winner === "player") {
      el.textContent = t("hint.gameOver");
      el.classList.add("battle-hint--victory");
    } else {
      el.textContent = t("hint.gameOver");
      el.classList.add("battle-hint--defeat");
    }
    return;
  }
  if (battle.phase === "cpuThinking" || battle.turn === "cpu") {
    el.textContent = t("hint.cpuTurn");
    return;
  }

  switch (_uiState) {
    case "summoning": {
      const cardId = battle.player.hand[_selectedHandIdx];
      const def = getHeroDef(battle.cardDb, cardId);
      const rowLabel = def ? t(`battle.row.${def.row}`) : "";
      el.textContent = fillTemplate(t("hint.summoning"), { row: rowLabel });
      break;
    }
    case "actorSelected":
      el.textContent = t("hint.actorSelected");
      break;
    case "skillSelected":
      el.textContent = t("hint.skillSelected");
      break;
    case "targetPreview":
      el.textContent = t("hint.targetPreview");
      break;
    default:
      if (_viewingTarget) {
        const isViewOnlyTarget = _viewingTarget.side === "cpu"
          || (_viewingTarget.side === "player" && _viewingTarget.slot === "master")
          || (_viewingTarget.side === "player" && !canActAtSlot(battle, _viewingTarget.slot));
        el.textContent = isViewOnlyTarget ? t("hint.viewOnly") : t("hint.idle");
      } else {
        el.textContent = t("hint.idle");
      }
  }
}

function canActAtSlot(battle, slot) {
  if (slot === "master") return false;
  const unit = battle.player.field[slot];
  return !!unit && canAttack(unit);
}

function renderEndTurnButton(battle) {
  const btn = $("#btnEndTurn");
  if (!btn) return;
  btn.disabled = !(battle.turn === "player" && battle.phase === "action");
}

// ============================================================
// Event handlers
// ============================================================
export function setupBattleUiEventListeners() {
  if (_listenersBound) return;
  _listenersBound = true;

  document.addEventListener("click", handleClick);
  onLangChange(() => renderBattle());
}

function handleClick(ev) {
  const battle = state.battle;
  if (!battle) return;
  if (battle.turn !== "player" || battle.phase !== "action") return;

  // 1. End Turn
  if (ev.target.closest("#btnEndTurn")) {
    onEndTurn();
    return;
  }
  // 2. Hand card
  const handCardEl = ev.target.closest(".hand-card");
  if (handCardEl && handCardEl.closest("#playerHand")) {
    onHandCardClick(handCardEl);
    return;
  }
  // 3. Skill card
  const skillCardEl = ev.target.closest(".skill-card");
  if (skillCardEl && skillCardEl.closest("#skillChooser")) {
    onSkillCardClick(skillCardEl);
    return;
  }
  // 4. Instr slot
  const slotEl = ev.target.closest(".instr-slot");
  if (slotEl) {
    onInstrSlotClick(slotEl);
    return;
  }
  // 5. それ以外 → cancel chain (= _viewingTarget は残す)
  if (_uiState !== "idle") {
    resetChain();
    renderBattle();
  }
}

function onHandCardClick(el) {
  const idx = Number(el.dataset.handIdx);
  if (el.classList.contains("hand-card--disabled")) {
    resetChain();
    renderBattle();
    return;
  }
  if (_uiState === "summoning" && _selectedHandIdx === idx) {
    resetChain();
  } else {
    resetChain();
    _uiState = "summoning";
    _selectedHandIdx = idx;
  }
  renderBattle();
}

function onSkillCardClick(el) {
  if (el.classList.contains("skill-card--disabled")) return;
  if (!_selectedActor) return;
  const skillId = el.dataset.skillId;
  const skill = getSkillDef(skillId);
  if (!skill) return;

  // 同じスキルを再タップ → deselect (= actorSelected に戻る)
  if (_selectedSkill && _selectedSkill.id === skill.id && _uiState !== "actorSelected") {
    _selectedSkill = null;
    _previewTarget = null;
    _uiState = "actorSelected";
    renderBattle();
    return;
  }

  _selectedSkill = skill;
  _previewTarget = null;
  _uiState = "skillSelected";
  renderBattle();
}

function onInstrSlotClick(slotEl) {
  const battle = state.battle;
  const side = slotEl.dataset.side;
  const slot = slotEl.dataset.target;
  const target = { side, slot };

  _viewingTarget = target;

  // summoning state: 召喚処理 or cancel
  if (_uiState === "summoning") {
    if (side === "player" && slot !== "master") {
      const cardId = battle.player.hand[_selectedHandIdx];
      const def = getHeroDef(battle.cardDb, cardId);
      if (def && def.row === slot) {
        const check = canSummon(battle.player, cardId, battle.cardDb, slot);
        if (check.ok) {
          executeSummon(cardId, slot);
          return;
        }
      }
    }
    // 失敗 / 無効 → cancel
    resetChain();
    _viewingTarget = target;
    renderBattle();
    return;
  }

  // targetPreview state: 同じ target → execute、 別 valid target → re-preview
  if (_uiState === "targetPreview" && _selectedSkill && _selectedActor) {
    if (sameTarget(_previewTarget, target)) {
      // 2nd tap → execute
      executeSkill();
      return;
    }
    if (isValidTargetForCurrentSkill(target)) {
      _previewTarget = target;
      renderBattle();
      return;
    }
    // invalid → 詳細だけ更新、 chain は保持
    renderBattle();
    return;
  }

  // skillSelected: 有効 target → 1st preview
  if (_uiState === "skillSelected" && _selectedSkill && _selectedActor) {
    if (isValidTargetForCurrentSkill(target)) {
      _previewTarget = target;
      _uiState = "targetPreview";
      renderBattle();
      return;
    }
    // 別 ally で actor 切替を試す
    if (side === "player" && slot !== "master") {
      const unit = battle.player.field[slot];
      if (unit && canAttack(unit) && !sameTarget(_selectedActor, target)) {
        _selectedActor = target;
        _selectedSkill = null;
        _previewTarget = null;
        _uiState = "actorSelected";
        renderBattle();
        return;
      }
    }
    // それ以外 → 詳細だけ更新、 chain は保持
    renderBattle();
    return;
  }

  // actorSelected: 別 ally で switch、 同 ally で解除、 skill 待ち
  if (_uiState === "actorSelected") {
    if (sameTarget(_selectedActor, target)) {
      resetChain();
      _viewingTarget = null;
      renderBattle();
      return;
    }
    if (side === "player" && slot !== "master") {
      const unit = battle.player.field[slot];
      if (unit && canAttack(unit)) {
        _selectedActor = target;
        renderBattle();
        return;
      }
    }
    // 詳細だけ更新 (= chain 保持)
    renderBattle();
    return;
  }

  // idle: ally hero (= 行動可) なら actor 選択へ、 そうでなければ view-only
  if (side === "player" && slot !== "master") {
    const unit = battle.player.field[slot];
    if (unit && canAttack(unit)) {
      _selectedActor = target;
      _uiState = "actorSelected";
      renderBattle();
      return;
    }
  }
  // それ以外は view-only
  renderBattle();
}

async function onEndTurn() {
  const battle = state.battle;
  if (!battle) return;
  if (battle.turn !== "player" || battle.phase !== "action") return;

  resetChain();
  _viewingTarget = null;
  endTurn(battle);
  renderBattle();

  const { runCpuTurn } = await import("./cpu-turn.js");
  await runCpuTurn(renderBattle, finishBattle);
}

// ============================================================
// Execute actions
// ============================================================
function executeSummon(cardId, row) {
  const battle = state.battle;
  try {
    summonHero(battle.player, cardId, battle.cardDb, row);
  } catch (e) {
    console.warn("[battle-ui] summon failed:", e.message);
    resetChain();
    renderBattle();
    return;
  }
  resetChain();
  // 詳細 view を新規 unit に
  _viewingTarget = { side: "player", slot: row };
  renderBattle();
  const portrait = $(`#instrPlayer${capitalize(row)} .instr-slot__portrait`);
  triggerSummonAnim(portrait);
}

async function executeSkill() {
  const battle = state.battle;
  const actor = _selectedActor;
  const skill = _selectedSkill;
  const target = _previewTarget;

  // 現状実装は 通常攻撃 のみ
  if (!skill.implemented || skill.id !== BASIC_ATTACK_ID) {
    console.warn("[battle-ui] skill not implemented yet:", skill?.id);
    resetChain();
    renderBattle();
    return;
  }

  // アニメ用 DOM 参照
  const attackerPortrait = $(`#instrPlayer${capitalize(actor.slot)} .instr-slot__portrait`);
  const targetEl = target.slot === "master"
    ? $(`#instrCpuMaster`)
    : $(`#instrCpu${capitalize(target.slot)} .instr-slot__portrait`);

  resetChain();
  renderBattle();

  triggerAttackAnim(attackerPortrait, "player");
  await delay(180);

  try {
    performAttack(battle.player, battle[target.side], actor.slot, target.slot);
  } catch (e) {
    console.warn("[battle-ui] attack failed:", e.message);
    renderBattle();
    return;
  }

  if (targetEl) triggerHitAnim(targetEl);
  await delay(360);

  const winner = checkVictory(battle);
  if (winner) {
    finishBattle(winner);
    return;
  }
  renderBattle();
}

function finishBattle(winner) {
  const battle = state.battle;
  battle.phase = "gameOver";
  battle.winner = winner;
  resetChain();
  _viewingTarget = null;
  renderBattle();
  import("./game-over.js").then(({ showGameOverScreen }) => {
    showGameOverScreen(battle, winner);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================
// Hand card detail (= summoning state)
// ============================================================
function renderHandCardDetail(root, battle) {
  const cardId = battle.player.hand[_selectedHandIdx];
  if (!cardId) return;
  const def = getHeroDef(battle.cardDb, cardId);
  if (!def) return;

  const detail = document.createElement("div");
  detail.className = "board-detail";
  const rowLabel = t(`battle.row.${def.row}`);
  detail.innerHTML = `
    <div class="board-detail__portrait" style="background-image: url('${def.portraitUrl}')"></div>
    <div class="board-detail__name">${escapeHtml(nameOf(def))}</div>
    <div class="board-detail__stats">
      <span class="hp">${t("board.detail.hp")} ${def.hp}</span>
      <span class="atk">${t("board.detail.atk")} ${def.atk}</span>
      <span class="stones">${t("board.detail.stones")} ${def.cost}</span>
    </div>
    <div class="board-detail__status">${escapeHtml(rowLabel)}</div>
  `;
  root.appendChild(detail);
}

// ============================================================
// Screen lifecycle
// ============================================================
export function enterBattleScreen() {
  $("#battleScreen")?.classList.remove("hidden");
  $("#stagePlaceholder")?.classList.add("hidden");
  setupBattleUiEventListeners();
  resetChain();
  _viewingTarget = null;
  renderBattle();
}

export function exitBattleScreen() {
  $("#battleScreen")?.classList.add("hidden");
  $("#stagePlaceholder")?.classList.remove("hidden");
  resetChain();
  _viewingTarget = null;
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
