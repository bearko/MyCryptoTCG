// pathfind.js — 移動コストと経路探索（A*・Dijkstra）。東西ループ
//
// 契約：docs/specs/SPEC-110-engine-contract.md §3 `pathfind.js`
//   stepCost(state, db, squad, hero, toIdx) → number | Infinity
//   findPath(state, db, squad, hero, toIdx) → { path: tileIdx[], cost } | null   （path に今いるタイルは含まない）
//   reachable(state, db, squad, hero, ap) → Map<tileIdx, cost>                   （今いるタイルも cost 0 で含む）
//
// DOM に触れない純粋関数。state は読むだけで書き換えない。
// 季節による体力減は扱わない（turn 班）。
//
// コストの決まり（spec §3.1・§5.2）：
//   - passable: false は Infinity。ただし scoutCost を持つ地形（山岳・火山）は、先鋒 vanguard／偵察 scout だけ scoutCost で通れる
//   - 草原（nonFrontCost）は前衛（cls.main === "front"）以外は nonFrontCost
//   - 敵ランドの部隊がいるタイル・敵の砦・敵の本拠地は Infinity（戦闘で解決する）

import { neighbors, distance } from './hex.js';

const ENEMY_LAND = 'enemy';

/** 山岳・火山を通れる小分類 */
const CLIMBERS = new Set(['vanguard', 'scout']);

/** 地形だけで決まるコスト（敵の有無は見ない） */
function terrainCost(t, hero) {
  if (!t) return Infinity;
  const main = hero && hero.cls ? hero.cls.main : null;
  const sub = hero && hero.cls ? hero.cls.sub : null;
  if (t.scoutCost != null && !t.passable) {
    return CLIMBERS.has(sub) ? t.scoutCost : Infinity;
  }
  if (!t.passable) return Infinity;
  if (t.nonFrontCost != null && main !== 'front') return t.nonFrontCost;
  return t.moveCost;
}

/**
 * squad から見て入れないタイル（敵部隊・敵の砦・敵の本拠地）の集合。
 * 経路探索のたびに全部隊を見直さないように、1 回だけ作る
 */
function hostileTiles(state, squad) {
  const set = new Set();
  const my = squad.land;
  const squads = state.squads || {};
  for (const id in squads) {
    const sq = squads[id];
    if (sq && sq.land !== my && sq.id !== squad.id) set.add(sq.tile);
  }
  const forts = state.forts || {};
  for (const id in forts) {
    const f = forts[id];
    if (f && f.owner !== my) set.add(f.tile);
  }
  const lands = state.lands || {};
  for (const id in lands) {
    const l = lands[id];
    if (l && id !== my && l.home != null) set.add(l.home);
  }
  // state.forts に無い砦のタイル（worldgen 直後など）は tile.owner で見る
  const tiles = state.map.tiles;
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    if (t.fort && !(forts[t.fort]) && t.owner !== my && t.owner === ENEMY_LAND) set.add(i);
  }
  return set;
}

function costWith(state, db, hero, hostile, toIdx) {
  const tile = state.map.tiles[toIdx];
  if (!tile) return Infinity;
  if (hostile.has(toIdx)) return Infinity;
  return terrainCost(db.terrain[tile.terrain], hero);
}

/** 1 歩のコスト。入れないなら Infinity */
export function stepCost(state, db, squad, hero, toIdx) {
  return costWith(state, db, hero, hostileTiles(state, squad), toIdx);
}

// 小さな二分ヒープ（[priority, value]）
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(p, v) {
    const a = this.a;
    a.push([p, v]);
    let i = a.length - 1;
    while (i > 0) {
      const j = (i - 1) >> 1;
      if (a[j][0] <= a[i][0]) break;
      [a[i], a[j]] = [a[j], a[i]];
      i = j;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * A*。ヒューリスティックは hex.distance（1 歩のコストが 1 以上なので許容的）。
 * 目的地に入れないなら null。今いるタイルが目的地なら { path: [], cost: 0 }
 */
export function findPath(state, db, squad, hero, toIdx) {
  const { w, h } = state.map;
  const start = squad.tile;
  if (start === toIdx) return { path: [], cost: 0 };
  const hostile = hostileTiles(state, squad);
  if (costWith(state, db, hero, hostile, toIdx) === Infinity) return null;

  const g = new Map([[start, 0]]);
  const prev = new Map();
  const closed = new Set();
  const open = new Heap();
  open.push(distance(start, toIdx, w, h), start);

  while (open.size) {
    const [, cur] = open.pop();
    if (closed.has(cur)) continue;
    if (cur === toIdx) break;
    closed.add(cur);
    const gc = g.get(cur);
    for (const n of neighbors(cur, w, h)) {
      if (closed.has(n)) continue;
      const c = costWith(state, db, hero, hostile, n);
      if (c === Infinity) continue;
      const ng = gc + c;
      if (ng < (g.has(n) ? g.get(n) : Infinity)) {
        g.set(n, ng);
        prev.set(n, cur);
        open.push(ng + distance(n, toIdx, w, h), n);
      }
    }
  }
  if (!g.has(toIdx)) return null;
  const path = [];
  for (let cur = toIdx; cur !== start; cur = prev.get(cur)) path.push(cur);
  path.reverse();
  return { path, cost: g.get(toIdx) };
}

/**
 * Dijkstra。ap 以内で届くタイルとそのコスト（今いるタイルは 0）
 */
export function reachable(state, db, squad, hero, ap) {
  const { w, h } = state.map;
  const start = squad.tile;
  const hostile = hostileTiles(state, squad);
  const dist = new Map([[start, 0]]);
  const done = new Set();
  const open = new Heap();
  open.push(0, start);
  while (open.size) {
    const [d, cur] = open.pop();
    if (done.has(cur)) continue;
    done.add(cur);
    for (const n of neighbors(cur, w, h)) {
      if (done.has(n)) continue;
      const c = costWith(state, db, hero, hostile, n);
      if (c === Infinity) continue;
      const nd = d + c;
      if (nd > ap) continue;
      if (nd < (dist.has(n) ? dist.get(n) : Infinity)) {
        dist.set(n, nd);
        open.push(nd, n);
      }
    }
  }
  return dist;
}
