// morale.js — 士気（Squad.morale）・配給（Land.ration）・夜の士気 / 逃走 / 兵の回復（SPEC-113 §1〜§3）
//
// DOM に触れない純粋関数。state を書き換えるのは「mutates」と書いたものだけ。
// 夜の処理は planNight（計算だけ）と applyNight（反映）に分ける。
// economy.breakdown（見込み）と turn.finishDay（実際）が同じ planNight を通るので、
// 内訳の「兵の回復」の行と、実際に夜に消費される人口が食い違わない。

import { neighbors } from './hex.js';
import { effectiveParams, troopCap, subMods } from './heroes.js';

/** 新しく作った部隊の士気 */
export const MORALE_START = 60;
export const MORALE_MIN = 0;
export const MORALE_MAX = 100;
/** これ未満は「動揺」（UI が強調する。ルール上の効果は士気係数だけ） */
export const MORALE_SHAKEN = 20;
/** 士気 0 の部隊が 1 日の終わりに失う兵の割合（切り上げ） */
export const DESERT_RATE = 0.08;
/** 砦・本拠地の守備兵は、この士気として数える */
export const STRUCTURE_MORALE = 60;

/** 出来事ごとの士気の変化（SPEC-113 §1.1）。routed / surrender は「この値にする」 */
export const MORALE_DELTA = Object.freeze({
  starve: -15,
  fed: 2,
  home: 3,
  commander: 2, // 指揮（commander）のヒーローが隣にいる
  commanderSelf: 2, // 指揮の部隊そのもの（§1.2）
  rest: 10,
  reward: 20,
  win: 8,
  lose: -8,
  ambushed: -15,
  fort: 5,
  routed: 30,
  surrender: 30,
});

/** スキルが戦闘で発動したときの士気（SPEC-113 §1.2）。self は自分の部隊、foe は相手の部隊 */
export const SKILL_MORALE = Object.freeze({
  buff: { self: 10, foe: 0 },
  heal: { self: 6, foe: 0 },
  debuff: { self: 0, foe: -10 },
  damage: { self: 0, foe: 0 },
});

/** 配給（SPEC-113 §3）。food は兵の食料の消費の倍率、morale は毎日の士気 */
export const RATIONS = Object.freeze({
  save: Object.freeze({ food: 0.75, morale: -4 }),
  normal: Object.freeze({ food: 1, morale: 0 }),
  feast: Object.freeze({ food: 1.25, morale: 4 }),
});
export const RATION_KINDS = ['save', 'normal', 'feast'];
export const DEFAULT_RATION = 'normal';

/** 恩賞の GUM（SPEC-113 §4）：10 + ceil(兵 ÷ 20) */
export const REWARD_BASE = 10;
export const REWARD_PER_TROOPS = 20;

function heroOf(db, squad) {
  return db.heroes[squad.heroId] || db.heroes[String(squad.heroId)];
}

/** 0〜100 の整数に切る */
export function clampMorale(v) {
  const n = Math.round(Number.isFinite(v) ? v : MORALE_START);
  return Math.max(MORALE_MIN, Math.min(MORALE_MAX, n));
}

/** 部隊の士気（古いセーブで無ければ 60） */
export function moraleOf(squad) {
  return squad && typeof squad.morale === 'number' ? squad.morale : MORALE_START;
}

/** 士気係数 0.75 + 0.005 × 士気（0 → ×0.75、50 → ×1.00、100 → ×1.25） */
export function moraleMult(morale) {
  const m = typeof morale === 'number' && Number.isFinite(morale) ? Math.max(MORALE_MIN, Math.min(MORALE_MAX, morale)) : MORALE_START;
  return 0.75 + 0.005 * m;
}

/** ランドの配給（無ければ "normal"） */
export function rationOf(land) {
  return land && RATIONS[land.ration] ? land.ration : DEFAULT_RATION;
}

/** 恩賞の GUM */
export function rewardCost(squad) {
  return REWARD_BASE + Math.ceil(Math.max(0, (squad && squad.troops) || 0) / REWARD_PER_TROOPS);
}

/**
 * mutates。士気を delta 動かす（上下限で切る）。実際に動いたら morale イベントを返し、動かなければ null。
 * @returns {null | {t:"morale", squad, delta, reason, value}}
 */
export function changeMorale(squad, delta, reason) {
  const before = moraleOf(squad);
  const value = clampMorale(before + delta);
  squad.morale = value;
  if (value === before) return null;
  return { t: 'morale', squad: squad.id, delta: value - before, reason, value };
}

/**
 * mutates。士気をその値にする（敗走・降伏）。動いたら morale イベント、動かなければ null。
 */
export function setMorale(squad, value, reason) {
  const before = moraleOf(squad);
  const v = clampMorale(value);
  squad.morale = v;
  if (v === before) return null;
  return { t: 'morale', squad: squad.id, delta: v - before, reason, value: v };
}

/** 戦える（敗走していない・兵がいる）部隊か */
function isActive(s) {
  return s && s.status !== 'routed' && (s.troops || 0) > 0;
}

/** squad の隣（自分を除く・同じランド・戦える）に、小分類が subs のどれかのヒーローがいるか */
function hasNeighborSub(state, db, squad, subs) {
  const { w, h } = state.map;
  const near = new Set(neighbors(squad.tile, w, h));
  for (const o of Object.values(state.squads)) {
    if (o.id === squad.id || o.land !== squad.land || !isActive(o) || !near.has(o.tile)) continue;
    const hero = heroOf(db, o);
    if (hero && hero.cls && subs.includes(hero.cls.sub)) return true;
  }
  return false;
}

/** 減りを半分にする（切り捨て）。−15 → −7 */
function halve(v) {
  return v < 0 ? -Math.floor(-v / 2) : v;
}

/**
 * 1 日の終わりの計画（state を変えない）。そのランドの部隊について、
 *   1. 士気の毎日の変化（飢え・食料が足りた・本拠地・配給・指揮）
 *   2. 士気 0 の逃走（兵の 8% 切り上げ）
 *   3. 兵の回復（支援 / 回復の隣は兵の上限 × healAdj、本拠地は +統率力。飢えた日は本拠地の回復なし。
 *      上限まで、人口 1 につき兵 1。人口が足りなければ足りる分だけ。部隊の並び順に配る）
 * @param {boolean} starved その日の食料が足りなかったか
 * @param {number} popAvail 回復に使える人口（その日の産出・上限のあと）
 * @returns {{ morale: Array<{squad, before, delta, value, reasons:string[]}>,
 *             desert: Array<{squad, amount, left}>,
 *             recover: Array<{squad, amount}>, popUsed: number }}
 */
export function planNight(state, db, landId, starved, popAvail) {
  const land = state.lands[landId];
  const out = { morale: [], desert: [], recover: [], popUsed: 0 };
  if (!land) return out;
  const ration = RATIONS[rationOf(land)];
  const squads = Object.values(state.squads).filter((s) => s.land === landId && s.status !== 'routed');
  const troops = new Map();
  const morale = new Map();

  // 1. 士気の毎日の変化
  for (const s of squads) {
    const hero = heroOf(db, s);
    const cushioned = hasNeighborSub(state, db, s, ['healer', 'support']);
    const reasons = [];
    let d = 0;
    const add = (v, reason) => {
      if (!v) return;
      d += v;
      reasons.push(reason);
    };
    add(starved ? (cushioned ? halve(MORALE_DELTA.starve) : MORALE_DELTA.starve) : MORALE_DELTA.fed, starved ? 'starve' : 'fed');
    if (land.home === s.tile) add(MORALE_DELTA.home, 'home');
    if (ration.morale) add(cushioned ? halve(ration.morale) : ration.morale, 'ration');
    if (hasNeighborSub(state, db, s, ['commander'])) add(MORALE_DELTA.commander, 'commander');
    if (hero && hero.cls && hero.cls.sub === 'commander') add(MORALE_DELTA.commanderSelf, 'commander');
    const before = moraleOf(s);
    const value = clampMorale(before + d);
    morale.set(s.id, value);
    out.morale.push({ squad: s.id, before, delta: value - before, value, reasons });
  }

  // 2. 士気 0 の逃走
  for (const s of squads) {
    let t = Math.max(0, s.troops || 0);
    if (morale.get(s.id) === 0 && t > 0) {
      const amount = Math.min(t, Math.ceil(t * DESERT_RATE));
      t -= amount;
      out.desert.push({ squad: s.id, amount, left: t });
    }
    troops.set(s.id, t);
  }

  // 3. 兵の回復（人口を消費する）
  const want = new Map();
  const { w, h } = state.map;
  for (const s of squads) {
    const hero = heroOf(db, s);
    if (!hero) continue;
    const adj = subMods(hero.cls && hero.cls.sub).healAdj;
    if (adj > 0) {
      const near = new Set(neighbors(s.tile, w, h));
      for (const o of squads) {
        if (o.id === s.id || !near.has(o.tile)) continue;
        const oh = heroOf(db, o);
        if (!oh) continue;
        want.set(o.id, (want.get(o.id) || 0) + Math.round(troopCap(oh, o, db) * adj));
      }
    }
    if (!starved && land.home === s.tile) {
      want.set(s.id, (want.get(s.id) || 0) + effectiveParams(hero, s, db).lead);
    }
  }
  let pop = Math.max(0, Math.floor(popAvail || 0));
  for (const s of squads) {
    const n = want.get(s.id);
    if (!n) continue;
    const hero = heroOf(db, s);
    const cur = troops.get(s.id);
    const room = Math.max(0, troopCap(hero, s, db) - cur);
    const give = Math.max(0, Math.min(room, n, pop));
    if (give <= 0) continue;
    pop -= give;
    out.popUsed += give;
    troops.set(s.id, cur + give);
    out.recover.push({ squad: s.id, amount: give });
  }
  return out;
}

/**
 * mutates。1 日の終わりの 士気 → 逃走 → 兵の回復（人口を消費）を反映する。
 * @returns {Event[]} morale_day（変化のあった部隊のまとめ。1 件も無ければ出さない）・desert
 */
export function applyNight(state, db, landId, starved) {
  const land = state.lands[landId];
  if (!land || land.alive === false) return [];
  const plan = planNight(state, db, landId, starved, land.res.pop);
  const events = [];
  const changes = [];
  for (const m of plan.morale) {
    state.squads[m.squad].morale = m.value;
    if (m.delta !== 0) changes.push({ squad: m.squad, delta: m.delta, reasons: m.reasons, value: m.value });
  }
  if (changes.length) events.push({ t: 'morale_day', land: landId, starved: !!starved, changes });
  for (const d of plan.desert) {
    state.squads[d.squad].troops = d.left;
    events.push({ t: 'desert', squad: d.squad, amount: d.amount, left: d.left });
  }
  for (const r of plan.recover) state.squads[r.squad].troops += r.amount;
  land.res.pop -= plan.popUsed;
  return events;
}
