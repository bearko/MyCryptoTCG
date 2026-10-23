// ai.js — CPU ランドの指示（SPEC-109 §7.3）
//
// 契約：docs/specs/SPEC-110-engine-contract.md §3 `ai.js`
//   plan(state, db, rng, landId)（mutates。orders.queue だけで指示を積む）
// DOM に触れない純粋関数。乱数は引数の rng だけ。軽さを優先して、1 部隊につき経路探索は数回まで。
//
// 毎ターンの流れ（部隊ごと）
//   1. policy を fight にする
//   2. 射程内に自分より兵の少ない敵ランドの部隊がいれば攻める
//   3. 本拠地にいれば、兵が少なければ徴兵、資源が乏しければ農作・商業・工作
//   4. 兵の多い上位（攻め手）は、いちばん近い未所有の砦へ向かい、射程内なら攻める
//      （Epic・Legendary は距離を割り引いて選ぶ。兵が少ないうちは Rare だけ）
//   5. それ以外は周りの未占領のタイルへ移動して占領し、資源があれば農地・街・採掘場を建てる

import { within, distance } from './hex.js';
import { findPath, reachable, stepCost } from './pathfind.js';
import { troopCap, rangeOf } from './heroes.js';
import { queue, projectedTile } from './orders.js';
import { canBuild, yields, upkeep } from './economy.js';
import { power, inRange } from './battle.js';

const ENEMY_LAND = 'enemy';

/** 砦の選び方：path のコストからこれを引く（大きいほど遠くても選ぶ） */
export const FORT_BONUS = { rare: 0, epic: 6, legendary: 18 };
/** その砦を狙ってよい兵の下限 */
export const FORT_MIN_TROOPS = { rare: 0, epic: 200, legendary: 450 };
/** 他ランドの砦は、エネミーの砦よりこれだけ遠く見る */
const OWNED_PENALTY = 12;
/** 建築のあとに残しておく GUM */
const GUM_RESERVE = 20;
/** 守り手が向かう砦までの距離の上限 */
const GUARD_RANGE = 14;

function heroOf(db, squad) {
  return db.heroes[squad.heroId] || db.heroes[String(squad.heroId)];
}

function at(squad, tile) {
  return tile === squad.tile ? squad : { ...squad, tile };
}

/** 射程内の、自分より兵の少ない敵ランドの部隊 */
function weakEnemyInRange(state, db, squad, here) {
  let best = null;
  for (const o of Object.values(state.squads)) {
    if (o.land === squad.land || o.land === ENEMY_LAND || o.status === 'routed' || o.troops <= 0) continue;
    if (o.troops >= squad.troops) continue;
    // 本拠地に立っている部隊は狙わない（攻撃が本拠地の攻略になり、ランドを脱落させてしまうため）
    const ol = state.lands[o.land];
    if (ol && ol.home === o.tile) continue;
    if (!inRange(state, db, at(squad, here), o.tile)) continue;
    if (!best || o.troops < best.troops) best = o;
  }
  return best;
}

function attackRepeatedly(state, db, squad, targetTile, max) {
  let n = 0;
  while (n < max && squad.ap >= 2 && queue(state, db, squad.id, { type: 'attack', target: targetTile }).ok) n++;
  return n;
}

function domesticNeed(state, db, squad, hero) {
  const land = state.lands[squad.land];
  const r = land.res;
  const net = yields(state, db, squad.land).food - upkeep(state, db, squad.land).food;
  if (r.food < 80 || net < 0) return 'farm';
  if (squad.troops < troopCap(hero, squad, db) * 0.5 && r.pop >= 40 && net > 6) return 'conscript';
  if (r.gum < 50) return 'trade';
  if (r.mat < 30) return 'craft';
  return null;
}

/** 経路の、AP で払える先頭部分 */
function affordablePrefix(state, db, squad, hero, path, ap) {
  const out = [];
  let sum = 0;
  for (const i of path) {
    const c = stepCost(state, db, squad, hero, i);
    if (sum + c > ap) break;
    sum += c;
    out.push(i);
  }
  return out;
}

/** 攻め手：いちばん近い未所有の砦へ。射程内なら攻める */
function goFort(state, db, squad, hero) {
  const here = projectedTile(squad);
  const me = at(squad, here);
  const range = rangeOf(hero);
  const { w, h } = state.map;
  // すでに射程内の砦があれば攻める
  for (const f of Object.values(state.forts)) {
    if (f.owner === squad.land || squad.troops < FORT_MIN_TROOPS[f.rank]) continue;
    if (distance(here, f.tile, w, h) <= range) {
      if (attackRepeatedly(state, db, squad, f.tile, 4) > 0) return true;
    }
  }
  const costs = reachable(state, db, me, hero, Infinity);
  let best = null;
  for (const f of Object.values(state.forts)) {
    if (f.owner === squad.land || squad.troops < FORT_MIN_TROOPS[f.rank]) continue;
    let goal = null;
    let gc = Infinity;
    for (const t of within(f.tile, range, w, h)) {
      const c = costs.get(t);
      if (c !== undefined && c < gc) {
        gc = c;
        goal = t;
      }
    }
    if (goal === null) continue;
    const value = gc - FORT_BONUS[f.rank] + (f.owner === ENEMY_LAND ? 0 : OWNED_PENALTY);
    if (!best || value < best.value) best = { value, goal, fort: f };
  }
  if (!best) return false;
  const found = findPath(state, db, me, hero, best.goal);
  if (!found || found.path.length === 0) return false;
  const prefix = affordablePrefix(state, db, me, hero, found.path, squad.ap);
  if (prefix.length === 0) return false;
  if (!queue(state, db, squad.id, { type: 'move', path: prefix }).ok) return false;
  if (prefix[prefix.length - 1] === best.goal) attackRepeatedly(state, db, squad, best.fort.tile, 4);
  return true;
}

function claimable(state, landId, i) {
  const t = state.map.tiles[i];
  if (t.owner !== null || t.fort) return false;
  for (const l of Object.values(state.lands)) if (l.home === i) return false;
  return true;
}

/** 周りの未占領のタイルへ移動して占領する（最大 n 回） */
function expand(state, db, squad, hero, n) {
  for (let k = 0; k < n && squad.ap >= 1; k++) {
    const here = projectedTile(squad);
    if (claimable(state, squad.land, here) && queue(state, db, squad.id, { type: 'claim' }).ok) continue;
    const me = at(squad, here);
    const costs = reachable(state, db, me, hero, squad.ap - 1);
    let goal = null;
    let gc = Infinity;
    for (const [t, c] of costs) {
      if (t === here || !claimable(state, squad.land, t)) continue;
      const terr = db.terrain[state.map.tiles[t].terrain];
      // 建てられる地形を少し優先する
      const v = c - (terr && terr.buildable ? 0.5 : 0);
      if (v < gc) {
        gc = v;
        goal = t;
      }
    }
    if (goal === null) return;
    const found = findPath(state, db, me, hero, goal);
    if (!found || found.path.length === 0) return;
    if (!queue(state, db, squad.id, { type: 'move', path: found.path }).ok) return;
    if (!queue(state, db, squad.id, { type: 'claim' }).ok) return;
  }
}

/** 守り手のいない自ランドの砦（守り手を向かわせる候補） */
function unguardedForts(state, landId) {
  const out = [];
  for (const f of Object.values(state.forts)) {
    if (f.owner !== landId) continue;
    const guarded = Object.values(state.squads).some(
      (s) => s.land === landId && s.status !== 'routed' && (s.tile === f.tile || projectedTile(s) === f.tile)
    );
    if (!guarded) out.push(f);
  }
  return out;
}

/** 守り手：自ランドの砦へ向かって立つ。向かう先が無ければ false */
function goGuard(state, db, squad, hero, forts, claimed) {
  if (squad.tile !== projectedTile(squad)) return false;
  const here = squad.tile;
  for (const f of state.forts ? Object.values(state.forts) : []) {
    if (f.owner === squad.land && f.tile === here) return true; // もう立っている。そのまま守る
  }
  const { w, h } = state.map;
  let best = null;
  for (const f of forts) {
    if (claimed.has(f.id)) continue;
    const d = distance(here, f.tile, w, h);
    if (d > GUARD_RANGE) continue;
    if (!best || d < best.d) best = { f, d };
  }
  if (!best) return false;
  const found = findPath(state, db, squad, hero, best.f.tile);
  if (!found || found.path.length === 0) return false;
  if (!queue(state, db, squad.id, { type: 'move', path: found.path }).ok) return false;
  claimed.add(best.f.id);
  return true;
}

/** 立っているタイルに建てる。budget は今ターンに使ってよい GUM・素材の残り（mutates） */
function tryBuild(state, db, squad, budget) {
  if (squad.ap < 2) return;
  const here = projectedTile(squad);
  const land = state.lands[squad.land];
  const t = state.map.tiles[here];
  // 指示フェーズではまだ占領していない（claim を積んだだけ）タイルには建てられないので、占領済みのタイルだけ
  if (t.owner !== squad.land || t.facility) return;
  const net = yields(state, db, squad.land).food - upkeep(state, db, squad.land).food;
  const kinds = land.res.food < 120 || net < 5 ? ['farm', 'town', 'mine'] : ['town', 'farm', 'mine'];
  if (land.res.mat < 40) kinds.unshift('mine');
  for (const kind of kinds) {
    const chk = canBuild(state, db, squad.land, here, kind, at(squad, here));
    if (!chk.ok) continue;
    if (budget.gum - chk.cost.gum < GUM_RESERVE || budget.mat < chk.cost.mat) continue;
    if (queue(state, db, squad.id, { type: 'build', kind, rush: 0 }).ok) {
      budget.gum -= chk.cost.gum;
      budget.mat -= chk.cost.mat;
      return;
    }
  }
}

/**
 * mutates。そのランドの全部隊に指示を積む。
 * @param {object} state
 * @param {object} db
 * @param {() => number} rng
 * @param {string} landId
 */
export function plan(state, db, rng, landId) {
  const land = state.lands[landId];
  if (!land || land.alive === false) return;
  const mine = Object.values(state.squads).filter((s) => s.land === landId && s.status !== 'routed');
  for (const s of mine) s.policy = 'fight';
  // 兵と攻撃力で並べ、上位を攻め手にする
  const ranked = mine
    .map((s) => ({ s, atk: power(state, db, s).atk, r: rng() }))
    .sort((a, b) => b.atk - a.atk || a.r - b.r)
    .map((x) => x.s);
  const attackers = new Set(ranked.slice(0, ranked.length >= 3 ? Math.ceil(ranked.length / 2) : 1).map((s) => s.id));
  const budget = { gum: land.res.gum, mat: land.res.mat };
  const toGuard = unguardedForts(state, landId);
  const guardClaimed = new Set();

  for (const squad of ranked) {
    if (squad.ap <= 0) continue;
    const hero = heroOf(db, squad);
    if (!hero) continue;
    const enemy = weakEnemyInRange(state, db, squad, squad.tile);
    if (enemy) attackRepeatedly(state, db, squad, enemy.tile, 2);

    if (squad.tile === land.home && squad.ap >= 2) {
      const kind = domesticNeed(state, db, squad, hero);
      if (kind) queue(state, db, squad.id, { type: 'domestic', kind });
    }

    if (attackers.has(squad.id)) {
      if (!goFort(state, db, squad, hero)) expand(state, db, squad, hero, 2);
    } else if (squad.tile !== land.home && goGuard(state, db, squad, hero, toGuard, guardClaimed)) {
      // 砦を守る（立っている間は動かない）
    } else {
      tryBuild(state, db, squad, budget);
      expand(state, db, squad, hero, 3);
    }
  }
}
