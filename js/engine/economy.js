// economy.js — 資源（pop / food / gum / mat）・施設・内政・休息
//
// 契約：docs/specs/SPEC-110-engine-contract.md §3 `economy.js`
// 数値：docs/specs/SPEC-109-mycryptowars-mvp.md §4・§4.1・§6.5・§6.6
// DOM に触れない純粋関数。state を書き換えるのは「mutates」と書いたものだけ。
//

// SPEC-113（士気と食料）：兵の消費に配給の倍率、飢えは士気へ（即時の兵・人口の罰はやめた）、
// 兵の増加は人口を消費、内政に恩賞。見せ方のための見込みの関数（breakdown / forecast /
// previewDomestic / previewRation）もここに置く。UI はこれを呼び、計算し直さない。

import { neighbors } from './hex.js';
import { effectiveParams, troopCap } from './heroes.js';
import { TROOPS_PER_FOOD, farmAmount } from './tuning.js';
import {
  moraleMult, moraleOf, rationOf, rewardCost, changeMorale, planNight,
  RATIONS, RATION_KINDS, MORALE_DELTA, MORALE_MAX, MORALE_SHAKEN,
} from './morale.js';

export { moraleMult, rewardCost, RATIONS, RATION_KINDS };

export const RES_KEYS = ['pop', 'food', 'gum', 'mat'];

/** 上限の基本値（spec §4） */
export const BASE_CAPS = { pop: 100, food: 200, mat: 100 };

/** 内政の種類（spec §6.5・SPEC-113 §4 の恩賞） */
export const DOMESTIC_KINDS = ['conscript', 'farm', 'trade', 'craft', 'reward'];

/** 施設のランクの上限 */
export const MAX_RANK = 3;

const PRODUCE_KEYS = ['food', 'gum', 'mat'];

/** 通貨（GUM）の量を読む */
function gumOf(obj) {
  return obj && typeof obj.gum === 'number' ? obj.gum : 0;
}

function num(v) {
  return typeof v === 'number' ? v : 0;
}

function squadsOf(state) {
  return state.squads || {};
}

function heroOf(db, squad) {
  return db.heroes[squad.heroId] || db.heroes[String(squad.heroId)];
}

/** 地形の 1 日の産出 { food, gum, mat } */
export function terrainYield(db, terrainId) {
  const t = db.terrain[terrainId];
  const y = t && t.yield;
  return { food: num(y && y.food), gum: gumOf(y), mat: num(y && y.mat) };
}

/** そのランドが占領しているタイルの index */
function ownedTiles(state, landId) {
  const out = [];
  const tiles = state.map.tiles;
  for (let i = 0; i < tiles.length; i++) if (tiles[i].owner === landId) out.push(i);
  return out;
}

/**
 * 施設 1 つの 1 日の産出（街の隣接補正は含まない）。ランク n で ×n。
 * farm は (food + terrainAdj[地形]) × rank、mine は (mat + 隣接する山岳・火山の数 × mountainAdj) × rank。
 * 負にはしない。
 */
function facilityProduce(state, db, i) {
  const tile = state.map.tiles[i];
  const fac = tile.facility;
  const out = { food: 0, gum: 0, mat: 0 };
  if (!fac) return out;
  const def = db.facilities[fac.kind];
  if (!def) return out;
  const rank = fac.rank || 1;
  const eff = def.effect || {};
  const base = { food: num(eff.food), gum: gumOf(eff), mat: num(eff.mat) };
  if (def.terrainAdj && base.food) {
    base.food += num(def.terrainAdj[tile.terrain]);
  }
  if (def.mountainAdj && base.mat) {
    const { w, h } = state.map;
    let n = 0;
    for (const j of neighbors(i, w, h)) {
      const tt = state.map.tiles[j].terrain;
      if (tt === 'mountain' || tt === 'volcano') n++;
    }
    base.mat += n * def.mountainAdj;
  }
  for (const k of PRODUCE_KEYS) out[k] = Math.max(0, base[k] * rank);
  return out;
}

/**
 * 上限（spec §4）。pop 100 + popCap、food 200 + foodCap、mat 100 + matCap。gum は上限なし。
 * @returns {{pop:number, food:number, mat:number}}
 */
export function caps(state, db, landId) {
  const out = { ...BASE_CAPS };
  for (const i of ownedTiles(state, landId)) {
    const fac = state.map.tiles[i].facility;
    if (!fac) continue;
    const def = db.facilities[fac.kind];
    if (!def || !def.effect) continue;
    const rank = fac.rank || 1;
    out.pop += num(def.effect.popCap) * rank;
    out.food += num(def.effect.foodCap) * rank;
    out.mat += num(def.effect.matCap) * rank;
  }
  return out;
}

/**
 * 1 日の産出の内訳（yields と breakdown が同じものを使う）。
 * terrain：占領タイルの地形、facility：施設の種類ごと、town：街の隣接補正、growth：人口の自然増。
 * 街の隣接補正：街以外の施設のタイルについて、隣接する（同じランドの）街 1 つにつき、
 * その施設が産出している資源それぞれに adjacentBonus × 街のランク を足す。
 */
function yieldParts(state, db, landId) {
  const terrain = { food: 0, gum: 0, mat: 0 };
  const town = { food: 0, gum: 0, mat: 0 };
  const facility = {}; // kind -> { food, gum, mat }
  const { w, h, tiles } = state.map;
  for (const i of ownedTiles(state, landId)) {
    const tile = tiles[i];
    const ty = terrainYield(db, tile.terrain);
    for (const k of PRODUCE_KEYS) terrain[k] += ty[k];
    if (!tile.facility) continue;
    const fp = facilityProduce(state, db, i);
    const kind = tile.facility.kind;
    if (!facility[kind]) facility[kind] = { food: 0, gum: 0, mat: 0 };
    for (const k of PRODUCE_KEYS) facility[kind][k] += fp[k];
    if (kind === 'town') continue;
    for (const j of neighbors(i, w, h)) {
      const nt = tiles[j];
      if (nt.owner !== landId || !nt.facility || nt.facility.kind !== 'town') continue;
      const tdef = db.facilities.town;
      const bonus = num(tdef && tdef.adjacentBonus) * (nt.facility.rank || 1);
      for (const k of PRODUCE_KEYS) if (fp[k] > 0) town[k] += bonus;
    }
  }
  const growth = Math.round(caps(state, db, landId).pop * 0.01);
  return { terrain, facility, town, growth };
}

/**
 * 1 日の産出（spec §4・§4.1）。
 * 占領タイルの地形の産出 + 施設の産出 + 街の隣接補正 + 人口の自然増 round(pop 上限 × 0.01)。
 * 人口の自然増は、食料が足りなかった日には起きない（applyDaily が見る。SPEC-113 §2）。
 * @returns {{pop:number, food:number, gum:number, mat:number}}
 */
export function yields(state, db, landId) {
  const p = yieldParts(state, db, landId);
  const out = { pop: p.growth, food: 0, gum: 0, mat: 0 };
  for (const k of PRODUCE_KEYS) {
    out[k] += p.terrain[k] + p.town[k];
    for (const kind in p.facility) out[k] += p.facility[kind][k];
  }
  return out;
}

/** そのランドの全部隊の兵の合計 */
export function totalTroops(state, landId) {
  let n = 0;
  const squads = squadsOf(state);
  for (const id in squads) if (squads[id].land === landId) n += squads[id].troops || 0;
  return n;
}

/** 配給の倍率を 4 分の 1 単位の整数で（0.75 → 3、1 → 4、1.25 → 5）。割り算の誤差を出さないため */
function rationQuarters(ration) {
  return Math.round(RATIONS[ration].food * 4);
}

/**
 * 兵の食料の消費（SPEC-113 §3）。ランド全体で floor(兵の合計 × 配給 ÷ d) を、部隊ごとの行に分ける
 * （各部隊の取り分を切り捨て、余りは端数の大きい部隊から 1 ずつ。同じなら並び順）。行の合計は必ず total。
 * @param {object} [opt] { ration：配給を差し替える, extra：兵の合計に足す（見込み用）, troops：部隊 id → 兵（見込み用） }
 * @returns {{ total:number, rows: Array<{squad:string, value:number}> }}
 */
export function troopFood(state, db, landId, opt = {}) {
  void db;
  const land = state.lands[landId];
  const ration = opt.ration && RATIONS[opt.ration] ? opt.ration : rationOf(land);
  const q = rationQuarters(ration);
  const den = 4 * TROOPS_PER_FOOD;
  const list = [];
  for (const s of Object.values(squadsOf(state))) {
    if (s.land !== landId) continue;
    const t = Math.max(0, opt.troops && opt.troops[s.id] !== undefined ? opt.troops[s.id] : s.troops || 0);
    list.push({ squad: s.id, t });
  }
  let sum = 0;
  for (const x of list) sum += x.t;
  const extra = Math.max(0, opt.extra || 0);
  const total = Math.floor(((sum + extra) * q) / den);
  // extra は見込みだけ（部隊の行には分けない）なので、行は部隊の兵だけで分ける
  const base = Math.floor((sum * q) / den);
  const rows = list.map((x, i) => ({ squad: x.squad, value: Math.floor((x.t * q) / den), rem: (x.t * q) % den, i }));
  let left = base - rows.reduce((a, r) => a + r.value, 0);
  const order = [...rows].sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (const r of order) {
    if (left <= 0) break;
    r.value += 1;
    left -= 1;
  }
  return { total, rows: rows.map((r) => ({ squad: r.squad, value: r.value })) };
}

/** 人口の食料の消費 floor(人口 ÷ 10)（配給に関係しない） */
function popFood(pop) {
  return Math.floor(Math.max(0, pop || 0) / 10);
}

/**
 * 毎日の食料の消費（spec §4・SPEC-113 §3）。floor(人口 ÷ 10) + floor(兵 × 配給 ÷ d)。
 * @returns {{food:number}}
 */
export function upkeep(state, db, landId) {
  const land = state.lands[landId];
  const pop = land ? land.res.pop : 0;
  return { food: popFood(pop) + troopFood(state, db, landId).total };
}

/**
 * mutates。産出 → 消費（配給を掛ける）→ 飢え → 上限。
 * 食料が負になったら 0 にして starve（shortfall は足りなかった量）。その日は人口の自然増なし。
 * 飢えの罰（士気 −15）と兵の回復は turn.finishDay が morale.applyNight で行う（SPEC-113 §2・§6.3）。
 * yield イベントの res は、この日の実際の増減（最終値 − 前日の値）。
 * @returns {Event[]}
 */
export function applyDaily(state, db, landId) {
  const land = state.lands[landId];
  if (!land || land.alive === false) return [];
  const res = land.res;
  const before = { ...res };
  const y = yields(state, db, landId);
  const up = upkeep(state, db, landId);
  for (const k of PRODUCE_KEYS) res[k] = num(res[k]) + y[k];
  res.food -= up.food;
  let shortfall = 0;
  if (res.food < 0) {
    shortfall = -res.food;
    res.food = 0;
  }
  res.pop = num(res.pop) + (shortfall > 0 ? 0 : y.pop);
  const cap = caps(state, db, landId);
  for (const k of ['pop', 'food', 'mat']) if (res[k] > cap[k]) res[k] = cap[k];
  const events = [];
  const delta = {};
  for (const k of RES_KEYS) delta[k] = res[k] - num(before[k]);
  events.push({ t: 'yield', land: landId, res: delta });
  if (shortfall > 0) events.push({ t: 'starve', land: landId, shortfall });
  return events;
}

/** 施設の費用 { gum, mat } */
export function buildCost(db, kind) {
  const def = db.facilities[kind];
  if (!def) return { gum: 0, mat: 0 };
  return { gum: gumOf(def.cost), mat: num(def.cost && def.cost.mat) };
}

/**
 * 建てられるか（spec §4.1・§6.3）。
 * days は max(1, 日数 − floor(統治力 / 10))。統治力は第 6 引数の部隊（の装備込み）から読む。
 * 部隊を渡さなければ統治力 0 として数える（契約の 5 引数のままでも呼べる）。
 * reason: "tile" | "kind" | "owner" | "fort" | "terrain" | "water" | "other" | "rank" | "building" | "gum" | "mat"
 * @returns {{ok:boolean, reason:string|null, cost:{gum:number, mat:number}, days:number, toRank:1|2|3}}
 */
export function canBuild(state, db, landId, tileIdx, kind, squad = null) {
  const def = db.facilities[kind];
  const cost = buildCost(db, kind);
  let gov = 0;
  if (squad) {
    const hero = heroOf(db, squad);
    if (hero) gov = effectiveParams(hero, squad, db).gov || 0;
  }
  const days = def ? Math.max(1, def.days - Math.floor(gov / 10)) : 1;
  const tile = state.map.tiles[tileIdx];
  const fail = (reason, toRank = 1) => ({ ok: false, reason, cost, days, toRank });
  if (!tile) return fail('tile');
  if (!def) return fail('kind');
  const toRank = tile.facility && tile.facility.kind === kind ? (tile.facility.rank || 1) + 1 : 1;
  if (tile.owner !== landId) return fail('owner', toRank);
  if (tile.fort) return fail('fort', toRank);
  const terr = db.terrain[tile.terrain];
  if (!terr || !terr.buildable || !def.terrains.includes(tile.terrain)) return fail('terrain', toRank);
  if (def.needsWater) {
    const { w, h, tiles } = state.map;
    const wet = neighbors(tileIdx, w, h).some((j) => {
      const t = db.terrain[tiles[j].terrain];
      return t && t.water === true;
    });
    if (!wet) return fail('water', toRank);
  }
  if (tile.facility && tile.facility.kind !== kind) return fail('other', toRank);
  if (toRank > MAX_RANK) return fail('rank', MAX_RANK);
  if (state.builds && state.builds[tileIdx]) return fail('building', toRank);
  const land = state.lands[landId];
  if (!land) return fail('owner', toRank);
  if (num(land.res.gum) < cost.gum) return fail('gum', toRank);
  if (num(land.res.mat) < cost.mat) return fail('mat', toRank);
  return { ok: true, reason: null, cost, days, toRank };
}

/**
 * mutates。部隊の立っているタイルで建築を始める。費用を引き、state.builds に積む。
 * rush（余りの AP）1 につき 1 日縮む（最短 1 日）。
 * 建てられなくなっていたら（実行までに状況が変わった）何も変えず
 * { t: "blocked", squad, at, reason: "build" } を返す。
 * @returns {Event}
 */
export function startBuild(state, db, squad, kind, rush = 0) {
  const tileIdx = squad.tile;
  const chk = canBuild(state, db, squad.land, tileIdx, kind, squad);
  if (!chk.ok) return { t: 'blocked', squad: squad.id, at: tileIdx, reason: 'build' };
  const land = state.lands[squad.land];
  land.res.gum -= chk.cost.gum;
  land.res.mat -= chk.cost.mat;
  const days = Math.max(1, chk.days - Math.max(0, Math.floor(rush || 0)));
  if (!state.builds) state.builds = {};
  state.builds[tileIdx] = { tileIdx, kind, land: squad.land, daysLeft: days, toRank: chk.toRank };
  return { t: 'build_start', squad: squad.id, tile: tileIdx, kind, days };
}

/**
 * mutates。建築の残り日数を 1 減らし、0 で施設にする。
 * タイルの持ち主が建築したランドでなくなっていたら、その建築は消える（イベントなし）。
 * @returns {Event[]} build_done の配列（タイル index の昇順）
 */
export function tickBuilds(state, db) {
  void db;
  const events = [];
  const builds = state.builds || {};
  const keys = Object.keys(builds).map(Number).sort((a, b) => a - b);
  for (const k of keys) {
    const b = builds[k];
    const tile = state.map.tiles[b.tileIdx];
    if (!tile || tile.owner !== b.land) {
      delete builds[k];
      continue;
    }
    b.daysLeft -= 1;
    if (b.daysLeft <= 0) {
      tile.facility = { kind: b.kind, rank: b.toRank };
      delete builds[k];
      events.push({ t: 'build_done', tile: b.tileIdx, kind: b.kind, rank: b.toRank, land: b.land });
    }
  }
  return events;
}

/** 積んである移動を終えたあとに立っているタイル（orders.projectedTile と同じ。循環 import を避けて写す） */
function endTile(squad) {
  let tile = squad.tile;
  for (const o of squad.orders || []) {
    if (o.type === 'move' && Array.isArray(o.path) && o.path.length) tile = o.path[o.path.length - 1];
  }
  return tile;
}

/**
 * 内政 1 回の効果を計算する（state は変えない）。cur は今の値 { res, troops, morale }。
 * conscript：min(floor(pop × 0.3), 兵の上限 − いまの兵) を pop から部隊の兵へ
 * farm：food +(10 + 統治力 × m)、trade：gum +(8 + 政治力)、craft：mat +(6 + floor(統治力 / 2))
 * reward：GUM 10 + ceil(兵 ÷ 20) を払い、士気 +20（GUM が足りなければ何もしない。ok = false）
 * food・mat は上限で止める。
 * @returns {{ok:boolean, d:{pop,food,gum,mat,troops,morale}, amount:number, cost:number}}
 */
function domesticCalc(state, db, squad, kind, cur, checkGum = true) {
  const hero = heroOf(db, squad);
  const p = effectiveParams(hero, squad, db);
  const res = cur.res;
  const d = { pop: 0, food: 0, gum: 0, mat: 0, troops: 0, morale: 0 };
  let amount = 0;
  let cost = 0;
  let ok = true;
  if (kind === 'conscript') {
    const room = troopCap(hero, squad, db) - cur.troops;
    amount = Math.max(0, Math.min(conscriptFromPop(res.pop), room));
    d.pop = -amount;
    d.troops = amount;
  } else if (kind === 'trade') {
    amount = 8 + p.pol;
    d.gum = amount;
  } else if (kind === 'farm' || kind === 'craft') {
    const key = kind === 'farm' ? 'food' : 'mat';
    const add = kind === 'farm' ? farmAmount(p.gov) : 6 + Math.floor(p.gov / 2);
    const cap = caps(state, db, squad.land)[key];
    const now = num(res[key]);
    const next = Math.max(now, Math.min(cap, now + add));
    amount = next - now;
    d[key] = amount;
  } else if (kind === 'reward') {
    cost = rewardCost({ troops: cur.troops });
    if (checkGum && num(res.gum) < cost) {
      ok = false;
      cost = 0;
    } else {
      d.gum = -cost;
      d.morale = Math.min(MORALE_MAX, cur.morale + MORALE_DELTA.reward) - cur.morale;
      amount = d.morale;
    }
  } else {
    ok = false;
  }
  return { ok, d, amount, cost };
}

/**
 * 休息 1 回の効果（state は変えない）。兵を 統率力 × 2（本拠地なら ×2）回復（上限まで・人口 1 につき兵 1）、士気 +10。
 */
function restCalc(state, db, squad, cur, tile) {
  const hero = heroOf(db, squad);
  const p = effectiveParams(hero, squad, db);
  const land = state.lands[squad.land];
  const atHome = land && land.home === tile;
  const heal = p.lead * 2 * (atHome ? 2 : 1);
  const room = troopCap(hero, squad, db) - cur.troops;
  const amount = Math.max(0, Math.min(room, heal, Math.floor(num(cur.res.pop))));
  const morale = Math.min(MORALE_MAX, cur.morale + MORALE_DELTA.rest) - cur.morale;
  return { amount, morale };
}

/**
 * mutates。内政（spec §6.5・SPEC-113 §4）。本拠地にいるかは orders.validate が見る。
 * amount は実際に増えた量（恩賞は士気の増えた量）。恩賞は cost（払った GUM）と morale（morale イベント|null）も返す。
 * @returns {Event} { t: "domestic", squad, kind, amount, cost?, morale? }
 */
export function domestic(state, db, squad, kind) {
  const land = state.lands[squad.land];
  const res = land.res;
  const c = domesticCalc(state, db, squad, kind, { res, troops: squad.troops || 0, morale: moraleOf(squad) });
  const ev = { t: 'domestic', squad: squad.id, kind, amount: c.amount };
  if (!c.ok) {
    if (kind === 'reward') {
      ev.cost = 0;
      ev.morale = null;
    }
    return ev;
  }
  for (const k of RES_KEYS) if (c.d[k]) res[k] = num(res[k]) + c.d[k];
  if (c.d.troops) squad.troops = (squad.troops || 0) + c.d.troops;
  if (kind === 'reward') {
    ev.cost = c.cost;
    ev.morale = changeMorale(squad, MORALE_DELTA.reward, 'reward');
  }
  return ev;
}

/**
 * mutates。休息（spec §6.6・SPEC-113 §1.1・§2）。兵を 統率力 × 2（本拠地なら ×2）回復。兵の上限で止める。
 * 増えた兵 1 人につき人口 1 を消費する（人口が足りなければ足りる分だけ）。士気 +10。
 * @returns {Event} { t: "rest", squad, amount, morale }（amount は実際に増えた兵。morale は morale イベント|null）
 */
export function rest(state, db, squad) {
  const land = state.lands[squad.land];
  const res = land ? land.res : { pop: 0 };
  const c = restCalc(state, db, squad, { res, troops: squad.troops || 0, morale: moraleOf(squad) }, squad.tile);
  squad.troops = (squad.troops || 0) + c.amount;
  if (land) res.pop = num(res.pop) - c.amount;
  const morale = changeMorale(squad, MORALE_DELTA.rest, 'rest');
  return { t: 'rest', squad: squad.id, amount: c.amount, morale };
}

// ---------------------------------------------------------------- 施策（配給）

/**
 * mutates。ランドの配給を切り替える（AP を使わない。部隊の方針と同じ扱い）。
 * @returns {{ok:boolean, reason:string|null}} reason: "land" | "ration"
 */
export function setRation(state, landId, ration) {
  const land = state.lands[landId];
  if (!land) return { ok: false, reason: 'land' };
  if (!RATIONS[ration]) return { ok: false, reason: 'ration' };
  land.ration = ration;
  return { ok: true, reason: null };
}

// ---------------------------------------------------------------- 見込み（SPEC-113 §6.3）

/**
 * そのランドの、積んである内政・休息・開拓をそのまま実行したとしたときの値（state は変えない）。
 * 部隊の並び順に、各部隊の指示を積んだ順で数える（実行フェーズの順番とは違うことがある）。
 * @returns {{ res:{pop,food,gum,mat}, troops:{[squadId]:number}, morale:{[squadId]:number} }}
 */
function queuedSim(state, db, landId) {
  const land = state.lands[landId];
  const res = land ? { pop: num(land.res.pop), food: num(land.res.food), gum: num(land.res.gum), mat: num(land.res.mat) } : { pop: 0, food: 0, gum: 0, mat: 0 };
  const troops = {};
  const morale = {};
  const mine = Object.values(squadsOf(state)).filter((s) => s.land === landId);
  for (const s of mine) {
    troops[s.id] = s.troops || 0;
    morale[s.id] = moraleOf(s);
  }
  for (const s of mine) {
    let tile = s.tile;
    for (const o of s.orders || []) {
      if (o.type === 'move' && Array.isArray(o.path) && o.path.length) tile = o.path[o.path.length - 1];
      else if (o.type === 'domestic') {
        const c = domesticCalc(state, db, s, o.kind, { res, troops: troops[s.id], morale: morale[s.id] });
        if (!c.ok) continue;
        for (const k of RES_KEYS) res[k] += c.d[k];
        troops[s.id] += c.d.troops;
        morale[s.id] += c.d.morale;
      } else if (o.type === 'rest') {
        const c = restCalc(state, db, s, { res, troops: troops[s.id], morale: morale[s.id] }, tile);
        troops[s.id] += c.amount;
        res.pop -= c.amount;
        morale[s.id] += c.morale;
      } else if (o.type === 'build') {
        const cost = buildCost(db, o.kind);
        res.gum -= cost.gum;
        res.mat -= cost.mat;
      }
    }
  }
  return { res, troops, morale };
}

/** 徴兵 1 回で人口から移せる兵の数の上限（floor(人口 × 0.3)） */
function conscriptFromPop(pop) {
  return Math.floor(Math.max(0, num(pop)) * 0.3);
}

/**
 * 徴兵できるか（積んである内政・休息のあとの人口と兵で見る）。orders.validate と previewDomestic が使う。
 * 人口から 1 人も移せない（floor(人口 × 0.3) = 0。人口 0〜3）なら reason "pop"、
 * 兵が上限に届いていて増やせないなら "cap"（人口のほうを先に見る）。
 * @returns {{ok:boolean, reason:null|"pop"|"cap", amount:number, pop:number}} amount は増える兵、pop は使える人口
 */
export function canConscript(state, db, squad) {
  const sim = queuedSim(state, db, squad.land);
  const hero = heroOf(db, squad);
  const troops = sim.troops[squad.id] !== undefined ? sim.troops[squad.id] : squad.troops || 0;
  const fromPop = conscriptFromPop(sim.res.pop);
  const room = hero ? troopCap(hero, squad, db) - troops : 0;
  const amount = Math.max(0, Math.min(fromPop, room));
  let reason = null;
  if (fromPop <= 0) reason = 'pop';
  else if (room <= 0) reason = 'cap';
  return { ok: reason === null, reason, amount, pop: sim.res.pop };
}

/**
 * 恩賞を払えるか（積んである恩賞・開拓の GUM を引いた残りで見る）。orders.validate が使う。
 * @returns {{ok:boolean, cost:number, gum:number}} gum は使える残り
 */
export function canReward(state, db, squad) {
  const sim = queuedSim(state, db, squad.land);
  const cost = rewardCost({ troops: sim.troops[squad.id] !== undefined ? sim.troops[squad.id] : squad.troops || 0 });
  return { ok: sim.res.gum >= cost, cost, gum: sim.res.gum };
}

function daysLeftOf(stock, net) {
  return net < 0 ? Math.floor(Math.max(0, stock) / -net) + 1 : null;
}

function sumRows(rows) {
  let n = 0;
  for (const r of rows) n += r.value;
  return n;
}

function pushRow(rows, key, label, value, squad) {
  if (!value) return;
  const row = { key, label, value };
  if (squad !== undefined) row.squad = squad;
  rows.push(row);
}

function heroName(db, state, squadId) {
  const s = squadsOf(state)[squadId];
  const hero = s && heroOf(db, s);
  return hero ? hero.name : String(squadId);
}

function facilityLabel(db, kind) {
  const def = db.facilities[kind];
  return def && def.name ? def.name : kind;
}

/**
 * 今夜の資源の見込みの内訳（積んである指示は含まない。内政の見込みは previewDomestic の perDay を足す）。
 * 各資源 { income: Row[], expense: Row[], net, stock, cap, daysLeft }。Row = { key, label, value, squad? }（value は正）。
 * net = 収入の合計 − 支出の合計（行の合計は必ず net に一致する）。0 の行は入れない。
 * 上限を超えて捨てる分は支出の行 key "cap"。食料が足りない日は人口の自然増の行が無い（SPEC-113 §2）。
 * 人口の支出の「兵の回復」（key "recover"・部隊ごと）は、夜の士気・逃走を通した morale.planNight の値。
 * daysLeft は net がマイナスのときだけ floor(stock / −net) + 1（1 は「今夜尽きる」）、それ以外は null。
 * @returns {{ food, gum, mat, pop }}
 */
export function breakdown(state, db, landId) {
  const land = state.lands[landId];
  const res = land ? land.res : { pop: 0, food: 0, gum: 0, mat: 0 };
  const cap = caps(state, db, landId);
  const parts = yieldParts(state, db, landId);
  const out = {};

  for (const k of PRODUCE_KEYS) {
    const income = [];
    pushRow(income, 'terrain', '占領地の地形', parts.terrain[k]);
    for (const kind of Object.keys(parts.facility)) pushRow(income, `facility.${kind}`, facilityLabel(db, kind), parts.facility[kind][k]);
    pushRow(income, 'town', '街の隣接', parts.town[k]);
    out[k] = { income, expense: [] };
  }

  // 食料：人口と部隊ごとの兵
  const food = out.food;
  pushRow(food.expense, 'pop', '人口', popFood(res.pop));
  for (const r of troopFood(state, db, landId).rows) pushRow(food.expense, 'troops', heroName(db, state, r.squad), r.value, r.squad);
  const foodRaw = num(res.food) + sumRows(food.income) - sumRows(food.expense);
  const starved = foodRaw < 0;
  if (foodRaw > cap.food) pushRow(food.expense, 'cap', '上限を超えた分', foodRaw - Math.max(cap.food, 0));

  // 素材：上限
  const matRaw = num(res.mat) + sumRows(out.mat.income);
  if (matRaw > cap.mat) pushRow(out.mat.expense, 'cap', '上限を超えた分', matRaw - cap.mat);

  // 人口：自然増（飢えた日は無し）→ 上限 → 兵の回復（人口を消費）
  const pop = { income: [], expense: [] };
  if (!starved) pushRow(pop.income, 'growth', '自然増', parts.growth);
  const popRaw = num(res.pop) + sumRows(pop.income);
  if (popRaw > cap.pop) pushRow(pop.expense, 'cap', '上限を超えた分', popRaw - cap.pop);
  const popAfter = Math.min(popRaw, cap.pop);
  if (land && land.alive !== false) {
    const night = planNight(state, db, landId, starved, popAfter);
    for (const r of night.recover) pushRow(pop.expense, 'recover', `兵の回復（${heroName(db, state, r.squad)}）`, r.amount, r.squad);
  }
  out.pop = pop;

  const result = {};
  for (const k of RES_KEYS) {
    const b = out[k];
    const net = sumRows(b.income) - sumRows(b.expense);
    const stock = num(res[k]);
    result[k] = {
      income: b.income,
      expense: b.expense,
      net,
      stock,
      cap: k === 'gum' ? null : cap[k],
      daysLeft: daysLeftOf(stock, net),
    };
  }
  return result;
}

/**
 * breakdown の要約と、兵・士気。
 * @returns {{ food:{net,daysLeft}, gum:{net,daysLeft}, mat:{net,daysLeft}, pop:{net,daysLeft},
 *             troops:{total, cap}, morale:{avg, min, shaken, deserting, desertTonight, desert} }}
 *   food.shortfall は今夜の食料の不足（在庫 + 差し引き が負のときのその大きさ。足りれば 0）。
 *     「あと N 足りない」に使う。0 より大きければ今夜は飢える（士気 −15）
 *   morale.avg は兵のいる部隊（敗走中を除く）の士気の単純平均（整数に丸める。部隊が無ければ null）、
 *   shaken は士気 20 未満の部隊の数、deserting は士気 0 で兵のいる部隊の数（いまの状態）、
 *   desertTonight は指示なしで今夜を迎えたときに逃げる兵の数（夜の士気の変化のあとで数える。morale.planNight）、
 *   desert はその部隊ごとの内訳 [{ squad, amount }]（逃げる部隊だけ。amount の合計は desertTonight と一致する）
 */
export function forecast(state, db, landId) {
  const b = breakdown(state, db, landId);
  const out = {};
  for (const k of RES_KEYS) out[k] = { net: b[k].net, daysLeft: b[k].daysLeft };
  out.food.shortfall = Math.max(0, -(b.food.stock + b.food.net));
  let total = 0;
  let cap = 0;
  let sum = 0;
  let n = 0;
  let min = null;
  let shaken = 0;
  let deserting = 0;
  for (const s of Object.values(squadsOf(state))) {
    if (s.land !== landId) continue;
    total += s.troops || 0;
    const hero = heroOf(db, s);
    if (hero) cap += troopCap(hero, s, db);
    if (s.status === 'routed') continue;
    const m = moraleOf(s);
    sum += m;
    n += 1;
    if (min === null || m < min) min = m;
    if (m < MORALE_SHAKEN) shaken += 1;
    if (m === 0 && (s.troops || 0) > 0) deserting += 1;
  }
  out.troops = { total, cap };
  // 今夜（指示なしで夜を迎えたら）逃げる兵の数。deserting は「いま士気 0」の部隊の数なので、
  // 食料が足りて +2 される夜は逃げない。UI が「今夜 −N 人」を出すときはこちらを使う
  let desertTonight = 0;
  const desert = [];
  const land = state.lands[landId];
  if (land && land.alive !== false) {
    const starved = out.food.shortfall > 0;
    for (const d of planNight(state, db, landId, starved, 0).desert) {
      desertTonight += d.amount;
      desert.push({ squad: d.squad, amount: d.amount });
    }
  }
  out.morale = { avg: n ? Math.round(sum / n) : null, min, shaken, deserting, desertTonight, desert };
  return out;
}

/**
 * 内政を 1 回積んだらどうなるかの見込み（state は変えない）。すでに積んである内政・休息・開拓のあとの値で数える。
 * delta：この 1 回で動く量 { food, gum, mat, pop, troops, morale }（恩賞で GUM が足りないときも、払えたときの値を出す）。
 * perDay.food：この指示で今日の食料の差し引きがどう変わるか（農作は増えた量、徴兵は 兵が増える分の消費のマイナス + 人口が減る分の消費のプラス。ほかは 0）。
 * repeat：今の AP であと何回積めるか（恩賞は GUM でも頭打ち）。
 * reason："kind" | "home" | "ap" | "gum" | "pop" | "cap"（この順に見る）
 *   pop：徴兵で人口から 1 人も移せない（人口 0〜3。orders.validate も同じ理由で断る）
 *   cap：この 1 回で何も増えない（農作・工作は食料・素材が上限、徴兵は兵が上限、恩賞は士気 100）。
 *        validate は断らないが、積んでも AP を使うだけなので UI は止めてよい
 * @returns {{ok:boolean, reason:string|null, delta:object, perDay:{food:number}, repeat:number}}
 */
export function previewDomestic(state, db, squad, kind) {
  const zero = { food: 0, gum: 0, mat: 0, pop: 0, troops: 0, morale: 0 };
  const land = state.lands[squad.land];
  if (!DOMESTIC_KINDS.includes(kind) || !land) return { ok: false, reason: 'kind', delta: zero, perDay: { food: 0 }, repeat: 0 };
  const sim = queuedSim(state, db, squad.land);
  const cur = { res: sim.res, troops: sim.troops[squad.id] || 0, morale: sim.morale[squad.id] !== undefined ? sim.morale[squad.id] : moraleOf(squad) };
  const c = domesticCalc(state, db, squad, kind, cur, false);
  const delta = { food: c.d.food, gum: c.d.gum, mat: c.d.mat, pop: c.d.pop, troops: c.d.troops, morale: c.d.morale };
  let perFood = 0;
  if (kind === 'farm') perFood = c.d.food;
  else if (kind === 'conscript' && c.d.troops > 0) {
    // 徴兵は人口を兵に移すので、兵の消費が増える分と、人口の消費（人口 ÷ 10）が減る分の両方を数える。
    // 兵の分だけにすると、UI の「このあと」が実際の翌日の食料より少なく出る（2 回の徴兵で 5〜6 ずれた）
    const before = popFood(sim.res.pop) + troopFood(state, db, squad.land, { troops: sim.troops }).total;
    const after = popFood(sim.res.pop + c.d.pop) + troopFood(state, db, squad.land, { troops: sim.troops, extra: c.d.troops }).total;
    perFood = before - after;
  }
  const ap = Math.max(0, squad.ap || 0);
  let repeat = Math.floor(ap / 2);
  if (kind === 'reward' && c.cost > 0) repeat = Math.min(repeat, Math.max(0, Math.floor(sim.res.gum / c.cost)));
  let reason = null;
  if (endTile(squad) !== land.home) reason = 'home';
  else if (ap < 2) reason = 'ap';
  else if (kind === 'reward' && sim.res.gum < c.cost) reason = 'gum';
  else if (kind === 'conscript' && conscriptFromPop(sim.res.pop) <= 0) reason = 'pop';
  else if (isNoGain(kind, delta)) reason = 'cap';
  return { ok: reason === null, reason, delta, perDay: { food: perFood }, repeat: reason === null ? repeat : 0 };
}

/** 内政 1 回で何も増えないか（previewDomestic の reason "cap"）。交易は上限が無いので増えないことが無い */
function isNoGain(kind, delta) {
  if (kind === 'farm') return delta.food <= 0;
  if (kind === 'craft') return delta.mat <= 0;
  if (kind === 'conscript') return delta.troops <= 0;
  if (kind === 'reward') return delta.morale <= 0;
  return false;
}

/**
 * 配給を切り替えたらどうなるかの見込み（state は変えない）。
 * perDay.food はその配給での食料の 1 日の差し引き（breakdown の net）、delta.food は今の配給との差。
 * @returns {{ perDay:{food:number}, delta:{food:number}, moralePerDay:number }}
 */
export function previewRation(state, db, landId, ration) {
  const land = state.lands[landId];
  const r = RATIONS[ration] ? ration : rationOf(land);
  const now = breakdown(state, db, landId).food.net;
  const lands = { ...state.lands, [landId]: { ...land, ration: r } };
  const then = breakdown({ ...state, lands }, db, landId).food.net;
  return { perDay: { food: then }, delta: { food: then - now }, moralePerDay: RATIONS[r].morale };
}
