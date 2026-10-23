// orders.js — 指示フェーズの指示（AP の計算・検証・積む・取り消す）
//
// 契約：docs/specs/SPEC-110-engine-contract.md §3 `orders.js`
// 数値：docs/specs/SPEC-109-mycryptowars-mvp.md §5.1・§6
// DOM に触れない純粋関数。state を書き換えるのは queue と clearOrders だけ。
//
// 指示は積んだ順に実行されるので、検証は「それより前に積んだ移動を終えた位置」で行う
// （移動してから占領・開拓・戦闘、のような積み方ができるように）。
//
// queue は積んだ指示に、実際に引いた AP を `ap` として書き添える（{ ...order, ap }）。
// clearOrders は db を受けないので、それを足し戻して AP を戻す。

import { neighbors } from './hex.js';
import { effectiveParams, subMods } from './heroes.js';
import { stepCost } from './pathfind.js';
import { canBuild, DOMESTIC_KINDS } from './economy.js';
import { inRange } from './battle.js';

export const ORDER_TYPES = ['move', 'claim', 'build', 'attack', 'domestic', 'rest'];

/** 指示ごとの固定の AP（spec §6） */
export const AP_COST = { claim: 1, build: 2, attack: 2, domestic: 2 };

function heroOf(db, squad) {
  return db.heroes[squad.heroId] || db.heroes[String(squad.heroId)];
}

/**
 * 1 ターンの AP の上限（spec §5.1・§5.2）。
 * 行動力（装備込み）+ 小分類の増減。routed なら 0。ambushed なら半分（切り上げ）。
 */
export function apMax(hero, squad, db) {
  if (squad && squad.status === 'routed') return 0;
  const p = effectiveParams(hero, squad, db);
  const sub = hero && hero.cls ? hero.cls.sub : null;
  let ap = Math.max(0, p.act + subMods(sub).actDelta);
  if (squad && squad.ambushed) ap = Math.ceil(ap / 2);
  return ap;
}

/** 積んである移動を終えたあとに立っているタイル */
export function projectedTile(squad) {
  let tile = squad.tile;
  for (const o of squad.orders || []) {
    if (o.type === 'move' && Array.isArray(o.path) && o.path.length) tile = o.path[o.path.length - 1];
  }
  return tile;
}

/** 部隊が別のタイルに立っているものとして扱うための写し */
function at(squad, tile) {
  return tile === squad.tile ? squad : { ...squad, tile };
}

/**
 * 指示の AP（spec §6）。move は path の各タイルの stepCost の合計（入れないタイルがあれば Infinity）。
 * claim 1、build 2 + rush、attack 2、domestic 2、rest は残りの AP 全部（squad.ap）。
 */
export function apCost(state, db, squad, order) {
  if (!order) return Infinity;
  switch (order.type) {
    case 'move': {
      if (!Array.isArray(order.path)) return Infinity;
      const hero = heroOf(db, squad);
      let sum = 0;
      for (const i of order.path) sum += stepCost(state, db, squad, hero, i);
      return sum;
    }
    case 'build':
      return AP_COST.build + Math.max(0, Math.floor(order.rush || 0));
    case 'claim':
    case 'attack':
    case 'domestic':
      return AP_COST[order.type];
    case 'rest':
      return Math.max(0, squad.ap || 0);
    default:
      return Infinity;
  }
}

/** そのタイルに、squad から見た敵（部隊・砦・本拠地）がいるか */
function hasEnemyAt(state, squad, tileIdx) {
  const squads = state.squads || {};
  for (const id in squads) {
    const s = squads[id];
    if (s.land !== squad.land && s.tile === tileIdx) return true;
  }
  const forts = state.forts || {};
  for (const id in forts) {
    const f = forts[id];
    if (f.tile === tileIdx && f.owner !== squad.land) return true;
  }
  const lands = state.lands || {};
  for (const id in lands) {
    if (id !== squad.land && lands[id].alive !== false && lands[id].home === tileIdx) return true;
  }
  return false;
}

/**
 * 指示を積めるか。reason は messages の order.reject.* に合わせて
 * "ap" | "home" | "range" | "build" のほか、"squad" | "type" | "path" | "terrain" | "claim" | "target" | "kind"。
 * 建てられない理由の細目は buildReason に入れる。
 * @returns {{ok:boolean, reason:string|null, buildReason?:string}}
 */
export function validate(state, db, squad, order) {
  const ng = (reason, extra) => ({ ok: false, reason, ...extra });
  if (!squad) return ng('squad');
  if (!order || !ORDER_TYPES.includes(order.type)) return ng('type');
  const hero = heroOf(db, squad);
  if (!hero) return ng('squad');
  const here = projectedTile(squad);
  const ap = squad.ap || 0;
  const { w, h, tiles } = state.map;

  switch (order.type) {
    case 'move': {
      const path = order.path;
      if (!Array.isArray(path) || path.length === 0) return ng('path');
      let prev = here;
      for (const i of path) {
        if (!Number.isInteger(i) || i < 0 || i >= tiles.length) return ng('path');
        if (!neighbors(prev, w, h).includes(i)) return ng('path');
        if (!Number.isFinite(stepCost(state, db, squad, hero, i))) return ng('terrain');
        prev = i;
      }
      // AP を超える移動も積める（実行フェーズで AP が尽きたところで止まる）。ただし AP 0 では積めない
      if (ap <= 0) return ng('ap');
      return { ok: true, reason: null };
    }
    case 'claim': {
      const tile = tiles[here];
      if (tile.owner === squad.land) return ng('claim');
      if (tile.fort) return ng('claim');
      if (hasEnemyAt(state, squad, here)) return ng('claim');
      break;
    }
    case 'build': {
      const chk = canBuild(state, db, squad.land, here, order.kind, at(squad, here));
      if (!chk.ok) return ng('build', { buildReason: chk.reason });
      break;
    }
    case 'attack': {
      const target = order.target;
      if (!Number.isInteger(target) || target < 0 || target >= tiles.length) return ng('target');
      if (!hasEnemyAt(state, squad, target)) return ng('target');
      if (!inRange(state, db, at(squad, here), target)) return ng('range');
      break;
    }
    case 'domestic': {
      if (!DOMESTIC_KINDS.includes(order.kind)) return ng('kind');
      const land = state.lands[squad.land];
      if (!land || land.home !== here) return ng('home');
      break;
    }
    case 'rest':
      if (ap <= 0) return ng('ap');
      return { ok: true, reason: null };
    default:
      return ng('type');
  }
  if (apCost(state, db, squad, order) > ap) return ng('ap');
  return { ok: true, reason: null };
}

/**
 * mutates。validate が ok なら squad.orders に積み、squad.ap から引く（0 で止める）。
 * 積む指示には実際に引いた AP を `ap` として書き添える。
 */
export function queue(state, db, squadId, order) {
  const squad = (state.squads || {})[squadId];
  const v = validate(state, db, squad, order);
  if (!v.ok) return v;
  const cost = apCost(state, db, squad, order);
  const charged = Math.min(squad.ap || 0, cost);
  if (!squad.orders) squad.orders = [];
  squad.orders.push({ ...order, ap: charged });
  squad.ap = (squad.ap || 0) - charged;
  return { ok: true, reason: null };
}

/** mutates。積んだ指示を捨て、引いた AP を戻す */
export function clearOrders(state, squadId) {
  const squad = (state.squads || {})[squadId];
  if (!squad) return;
  let back = 0;
  for (const o of squad.orders || []) back += typeof o.ap === 'number' ? o.ap : 0;
  squad.ap = (squad.ap || 0) + back;
  squad.orders = [];
}

/**
 * 積んだ指示の合計 AP。move は経路の本来のコスト（AP を超えた予定ぶんも含む）。
 * rest は積んだときに引いた AP。
 */
export function plannedAp(state, db, squad) {
  let sum = 0;
  for (const o of squad.orders || []) {
    if (o.type === 'rest') sum += typeof o.ap === 'number' ? o.ap : 0;
    else sum += apCost(state, db, squad, o);
  }
  return sum;
}
