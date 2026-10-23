// economy.js — 資源（pop / food / gum / mat）・施設・内政・休息
//
// 契約：docs/specs/SPEC-110-engine-contract.md §3 `economy.js`
// 数値：docs/specs/SPEC-109-mycryptowars-mvp.md §4・§4.1・§6.5・§6.6
// DOM に触れない純粋関数。state を書き換えるのは「mutates」と書いたものだけ。
//

import { neighbors } from './hex.js';
import { effectiveParams, troopCap } from './heroes.js';

export const RES_KEYS = ['pop', 'food', 'gum', 'mat'];

/** 上限の基本値（spec §4） */
export const BASE_CAPS = { pop: 100, food: 200, mat: 100 };

/** 内政の種類（spec §6.5） */
export const DOMESTIC_KINDS = ['conscript', 'farm', 'trade', 'craft'];

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
 * 1 日の産出（spec §4・§4.1）。
 * 占領タイルの地形の産出 + 施設の産出 + 街の隣接補正 + 人口の自然増 round(pop 上限 × 0.01)。
 * 街の隣接補正：街以外の施設のタイルについて、隣接する（同じランドの）街 1 つにつき、
 * その施設が産出している資源それぞれに adjacentBonus × 街のランク を足す。
 * @returns {{pop:number, food:number, gum:number, mat:number}}
 */
export function yields(state, db, landId) {
  const out = { pop: 0, food: 0, gum: 0, mat: 0 };
  const { w, h, tiles } = state.map;
  for (const i of ownedTiles(state, landId)) {
    const tile = tiles[i];
    const ty = terrainYield(db, tile.terrain);
    for (const k of PRODUCE_KEYS) out[k] += ty[k];
    if (!tile.facility) continue;
    const fp = facilityProduce(state, db, i);
    for (const k of PRODUCE_KEYS) out[k] += fp[k];
    if (tile.facility.kind === 'town') continue;
    for (const j of neighbors(i, w, h)) {
      const nt = tiles[j];
      if (nt.owner !== landId || !nt.facility || nt.facility.kind !== 'town') continue;
      const tdef = db.facilities.town;
      const bonus = num(tdef && tdef.adjacentBonus) * (nt.facility.rank || 1);
      for (const k of PRODUCE_KEYS) if (fp[k] > 0) out[k] += bonus;
    }
  }
  out.pop += Math.round(caps(state, db, landId).pop * 0.01);
  return out;
}

/** そのランドの全部隊の兵の合計 */
export function totalTroops(state, landId) {
  let n = 0;
  const squads = squadsOf(state);
  for (const id in squads) if (squads[id].land === landId) n += squads[id].troops || 0;
  return n;
}

/**
 * 毎日の食料の消費（spec §4）。floor(人口 ÷ 10) + floor(兵 ÷ 5)。
 * @returns {{food:number}}
 */
export function upkeep(state, db, landId) {
  void db;
  const land = state.lands[landId];
  const pop = land ? land.res.pop : 0;
  return { food: Math.floor(pop / 10) + Math.floor(totalTroops(state, landId) / 5) };
}

/**
 * mutates。産出 → 消費 → 上限 → 飢え。
 * yield イベントの res は、この日の実際の増減（最終値 − 前日の値。飢えの減少も含む）。
 * 食料が負になったら 0 にして、全部隊の兵を floor(兵 × 0.9)、人口を floor(人口 × 0.95) にし、starve を出す。
 * @returns {Event[]}
 */
export function applyDaily(state, db, landId) {
  const land = state.lands[landId];
  if (!land || land.alive === false) return [];
  const res = land.res;
  const before = { ...res };
  const y = yields(state, db, landId);
  const up = upkeep(state, db, landId);
  for (const k of RES_KEYS) res[k] = num(res[k]) + y[k];
  res.food -= up.food;
  const cap = caps(state, db, landId);
  for (const k of ['pop', 'food', 'mat']) if (res[k] > cap[k]) res[k] = cap[k];
  const events = [];
  let starved = false;
  if (res.food < 0) {
    starved = true;
    res.food = 0;
    const squads = squadsOf(state);
    for (const id of Object.keys(squads)) {
      const s = squads[id];
      if (s.land === landId) s.troops = Math.floor((s.troops || 0) * 0.9);
    }
    res.pop = Math.floor(res.pop * 0.95);
  }
  const delta = {};
  for (const k of RES_KEYS) delta[k] = res[k] - num(before[k]);
  events.push({ t: 'yield', land: landId, res: delta });
  if (starved) events.push({ t: 'starve', land: landId });
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

/**
 * mutates。内政（spec §6.5）。本拠地にいるかは orders.validate が見る。
 * conscript：min(floor(pop × 0.3), 兵の上限 − いまの兵) を pop から部隊の兵へ
 * farm：food +(10 + 統治力)、trade：gum +(8 + 政治力)、craft：mat +(6 + floor(統治力 / 2))
 * food・mat は上限で止める。amount は実際に増えた量。
 * @returns {Event} { t: "domestic", squad, kind, amount }
 */
export function domestic(state, db, squad, kind) {
  const land = state.lands[squad.land];
  const hero = heroOf(db, squad);
  const p = effectiveParams(hero, squad, db);
  const res = land.res;
  let amount = 0;
  if (kind === 'conscript') {
    const room = troopCap(hero, squad, db) - (squad.troops || 0);
    amount = Math.max(0, Math.min(Math.floor(res.pop * 0.3), room));
    res.pop -= amount;
    squad.troops = (squad.troops || 0) + amount;
  } else if (kind === 'trade') {
    amount = 8 + p.pol;
    res.gum = num(res.gum) + amount;
  } else if (kind === 'farm' || kind === 'craft') {
    const key = kind === 'farm' ? 'food' : 'mat';
    const add = kind === 'farm' ? 10 + p.gov : 6 + Math.floor(p.gov / 2);
    const cap = caps(state, db, squad.land)[key];
    const next = Math.max(res[key], Math.min(cap, res[key] + add));
    amount = next - res[key];
    res[key] = next;
  }
  return { t: 'domestic', squad: squad.id, kind, amount };
}

/**
 * mutates。休息（spec §6.6）。兵を 統率力 × 2（本拠地なら ×2）回復。兵の上限で止める。
 * @returns {Event} { t: "rest", squad, amount }（amount は実際に増えた兵）
 */
export function rest(state, db, squad) {
  const hero = heroOf(db, squad);
  const p = effectiveParams(hero, squad, db);
  const land = state.lands[squad.land];
  const atHome = land && land.home === squad.tile;
  const heal = p.lead * 2 * (atHome ? 2 : 1);
  const cap = troopCap(hero, squad, db);
  const cur = squad.troops || 0;
  const next = Math.max(cur, Math.min(cap, cur + heal));
  squad.troops = next;
  return { t: 'rest', squad: squad.id, amount: next - cur };
}
