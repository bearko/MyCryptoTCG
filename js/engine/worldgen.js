// worldgen.js — 世界の生成（幅 48 × 高さ 28・東西ループ・緯度帯で地形）
//
// 契約：docs/specs/SPEC-110-engine-contract.md §3 `worldgen.js`
//   generateWorld(seed, db, landIds) → { map: {w,h,tiles}, homes: {[landId]: tileIdx}, forts: Fort[] }
// DOM に触れない純粋関数。乱数は seed から作る（Math.random 禁止）。
//
// 流れ：
//   1. 値ノイズ（高さ・湿り気）を作り、高さの上位 ≈35% を陸にする
//   2. 緯度帯と湿り気で地形を決める（spec §3.1）。山岳 → 火山・崖、河川・湖・沼地・砂浜
//   3. 本拠地 9 つを経度 0 付近の温帯（北緯 20〜60°）の plain/grass に、互いに距離 4 以上で置く
//   4. 砦 Rare 6 / Epic 3 / Legendary 1 を、本拠地の群れの中心からの距離で置く（Legendary は経度 180°）
//   5. 全本拠地と全砦が陸路（passable）で同じ連結成分にあることを確かめる
//   どこかで失敗したら seed + 1 で作り直す（最大 50 回。陸を少しずつ増やす）

import { idx, col, row, wrapC, neighbors, distance, within, latitude } from './hex.js';
import { makeRng, rngInt, shuffle } from './rng.js';

export const WORLD_W = 48;
export const WORLD_H = 28;
export const MAX_ATTEMPTS = 50;

/** 砦の守備（spec §7.2） */
export const FORT_STATS = {
  rare: { troops: 60, durability: 40, label: 'Rare' },
  epic: { troops: 120, durability: 80, label: 'Epic' },
  legendary: { troops: 250, durability: 160, label: 'Legendary' },
};

// 本拠地を置く範囲（経度 0 付近・温帯）
const HOME_COL_SPAN = 10;       // c が -10..10（ループするので w-10..w-1 と 0..10）
const HOME_LAT_MIN = 20;        // 北緯 20〜60°
const HOME_LAT_MAX = 60;
const HOME_MIN_DIST = 4;

// 砦の距離帯（本拠地の群れの中心から）
const RARE_RANGE = [7, 9];
const EPIC_RANGE = [13, 16];
const LEGEND_LAT = [20, 60];    // |緯度| 20〜60°
const LEGEND_COL_TOL = 5;       // 経度 180° ± 5 列
const FORT_MIN_DIST = 3;        // 砦どうし・砦と本拠地の最小距離

// 乱数は rng.js の makeRng（mulberry32）。同じ seed なら同じ世界になる。
// seed 0 は 0x9e3779b9 に置き換える（以前の自前の生成器と同じ列を保つため）
function worldRng(seed) {
  return makeRng((seed >>> 0) || 0x9e3779b9);
}

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

/**
 * 値ノイズ。粗い格子に乱数を置き、滑らかに補間する。東西は格子ごとループする。
 * 返すのは w×h の Float64Array（0..1 付近）
 */
function valueNoise(rng, w, h, cells, octaves) {
  const out = new Float64Array(w * h);
  let amp = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const nx = cells * (1 << o);                 // 横の格子数（w を割り切らなくてもループはする）
    const ny = Math.max(2, Math.round(h / w * nx)) + 1;
    const grid = new Float64Array(nx * ny);
    for (let i = 0; i < grid.length; i++) grid[i] = rng();
    for (let r = 0; r < h; r++) {
      const fy = r / h * (ny - 1);
      const y0 = Math.floor(fy);
      const y1 = Math.min(ny - 1, y0 + 1);
      const ty = smoothstep(fy - y0);
      for (let c = 0; c < w; c++) {
        const fx = c / w * nx;
        const x0 = Math.floor(fx) % nx;
        const x1 = (x0 + 1) % nx;
        const tx = smoothstep(fx - Math.floor(fx));
        const v00 = grid[y0 * nx + x0], v10 = grid[y0 * nx + x1];
        const v01 = grid[y1 * nx + x0], v11 = grid[y1 * nx + x1];
        const v = (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
        out[r * w + c] += v * amp;
      }
    }
    total += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

/** c の、経度 0（c=0）からの折り返し距離（列数） */
function colDistFrom(c, c0, w) {
  const d = Math.abs(wrapC(c - c0, w));
  return Math.min(d, w - d);
}

/** 本拠地の範囲に入る行か */
function inHomeLat(r, h) {
  const lat = latitude(r, h);
  return lat >= HOME_LAT_MIN && lat <= HOME_LAT_MAX;
}

/**
 * 地形を 1 回ぶん生成する。失敗はしない（陸の割合だけ landBoost で変わる）
 * @returns {{ tiles: Tile[], landRatio: number }}
 */
function buildTerrain(rng, db, w, h, landBoost) {
  const n = w * h;
  const base = valueNoise(rng, w, h, 6, 4);      // 起伏（山岳はこちらで決める）
  const moist = valueNoise(rng, w, h, 5, 3);
  const height = Float64Array.from(base);

  // 本拠地の範囲（経度 0・北緯 40°）と、その裏側（経度 180°）を持ち上げて、
  // 本拠地の大陸と Legendary の大陸ができやすくする。極は沈める
  const homeR = (h - 1) * ((90 - 40) / 180);
  const inHomeCore = new Uint8Array(n);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      // 本拠地の範囲は中ほどを平らに持ち上げ（台地）、縁でなだらかに下ろす
      const dHome = Math.hypot(colDistFrom(c, 0, w) / 12, (r - homeR) / 5);
      const dFar = Math.hypot(colDistFrom(c, w / 2, w) / 8, (r - homeR) / 6);
      let lift = 0;
      if (dHome < 1.1) lift += 0.4 * smoothstep(Math.min(1, (1.1 - dHome) / 0.5));
      if (dFar < 1) lift += 0.2 * smoothstep(1 - dFar);
      // 温帯の帯を少し持ち上げて、本拠地の大陸と裏側の大陸が陸路でつながりやすくする
      const dBelt = Math.abs(r - homeR) / 5;
      if (dBelt < 1) lift += 0.08 * smoothstep(1 - dBelt);
      const lat = Math.abs(latitude(r, h));
      if (lat > 70) lift -= 0.15 * ((lat - 70) / 20);
      height[r * w + c] += lift;
      if (colDistFrom(c, 0, w) <= HOME_COL_SPAN && inHomeLat(r, h)) inHomeCore[r * w + c] = 1;
    }
  }

  // 高さの上位 (35% + landBoost) を陸にする
  const sorted = Array.from(height).sort((a, b) => a - b);
  const landTarget = Math.min(0.6, 0.35 + landBoost);
  const seaLevel = sorted[Math.floor(n * (1 - landTarget))];

  const terrain = new Array(n);
  const isLand = new Uint8Array(n);
  for (let i = 0; i < n; i++) isLand[i] = height[i] >= seaLevel ? 1 : 0;

  // 山岳：陸のうち起伏（持ち上げる前の値）が高い上位 9%。本拠地の範囲には作らない
  // （持ち上げた高さで決めると、本拠地の大陸が山だらけになる）
  const landBase = [];
  for (let i = 0; i < n; i++) if (isLand[i] && !inHomeCore[i]) landBase.push(base[i]);
  landBase.sort((a, b) => a - b);
  const mountainLevel = landBase.length ? landBase[Math.floor(landBase.length * 0.88)] : Infinity;
  const isMountain = (i) => isLand[i] && !inHomeCore[i] && base[i] >= mountainLevel;

  // 陸の基本地形（緯度帯と湿り気）
  for (let i = 0; i < n; i++) {
    if (!isLand[i]) { terrain[i] = 'deep'; continue; }
    const r = row(i, w);
    const lat = Math.abs(latitude(r, h));
    const m = moist[i];
    const relH = Math.min(1, (height[i] - seaLevel) / Math.max(1e-9, sorted[n - 1] - seaLevel)); // 0..1 で陸の低さ高さ
    if (isMountain(i)) { terrain[i] = 'mountain'; continue; }
    // 氷原は 45° 以上（spec）。ただし 45° 以上は行の半分を占めるので、極に近いほど濃くする
    if (lat >= 72) { terrain[i] = 'ice'; continue; }
    if (lat >= 58) { terrain[i] = m < 0.6 ? 'ice' : 'plain'; continue; }
    if (lat >= 45) { terrain[i] = m < 0.2 ? 'ice' : (m < 0.6 ? 'plain' : 'grass'); continue; }
    if (lat >= 20) {
      // 砂漠は 20〜50°。本拠地の範囲では少なめにする（本拠地は plain/grass にしか置けない）
      if (lat <= 50 && m < (inHomeCore[i] ? 0.18 : 0.32)) { terrain[i] = 'desert'; continue; }
      if (relH < 0.18 && m > 0.7) { terrain[i] = 'swamp'; continue; }
      terrain[i] = m < 0.55 ? 'plain' : 'grass';
      continue;
    }
    // 20° 未満（低緯度）
    if (relH < 0.22 && m > 0.6) { terrain[i] = 'swamp'; continue; }
    terrain[i] = m < 0.6 ? 'plain' : 'grass';
  }

  // 火山：山岳の一部。崖：山岳の縁の一部
  for (let i = 0; i < n; i++) {
    if (terrain[i] === 'mountain' && rng() < 0.15) terrain[i] = 'volcano';
  }
  const cliffs = [];
  for (let i = 0; i < n; i++) {
    if (!isLand[i] || terrain[i] === 'mountain' || terrain[i] === 'volcano') continue;
    const nearMt = neighbors(i, w, h).some(j => terrain[j] === 'mountain' || terrain[j] === 'volcano');
    if (nearMt && rng() < 0.3) cliffs.push(i);
  }
  for (const i of cliffs) terrain[i] = 'cliff';

  // 河川：山岳から海へ下る線を数本
  const mts = [];
  for (let i = 0; i < n; i++) if (terrain[i] === 'mountain' || terrain[i] === 'volcano') mts.push(i);
  const riverCount = rngInt(rng, 5, 8);
  const starts = shuffle(rng, mts).slice(0, riverCount * 2);
  let made = 0;
  for (const s of starts) {
    if (made >= riverCount) break;
    const path = [];
    let cur = s;
    let ok = false;
    for (let step = 0; step < 40; step++) {
      // いちばん低い隣へ（同じ高さ以下。山岳と崖は避ける）
      let best = -1;
      let bestH = height[cur];
      for (const j of neighbors(cur, w, h)) {
        const t = terrain[j];
        if (t === 'mountain' || t === 'volcano' || t === 'cliff') continue;
        if (height[j] <= bestH) { bestH = height[j]; best = j; }
      }
      if (best < 0) break;
      if (!isLand[best] || terrain[best] === 'river' || terrain[best] === 'lake') { ok = true; break; }
      path.push(best);
      cur = best;
    }
    if (ok && path.length >= 2) {
      for (const p of path) terrain[p] = 'river';
      made++;
    }
  }

  // 湖：陸の内側（隣が全部陸）の低い土地を少し
  const lakeCands = [];
  for (let i = 0; i < n; i++) {
    if (!isLand[i]) continue;
    const t = terrain[i];
    if (t !== 'plain' && t !== 'grass' && t !== 'swamp') continue;
    const ns = neighbors(i, w, h);
    if (ns.length < 6) continue;
    if (!ns.every(j => isLand[j] && terrain[j] !== 'river')) continue;
    lakeCands.push(i);
  }
  const lakeCount = Math.min(lakeCands.length, rngInt(rng, 3, 6));
  for (const i of shuffle(rng, lakeCands).slice(0, lakeCount)) {
    terrain[i] = 'lake';
    isLand[i] = 0;
  }

  // 砂浜：海に隣接する陸の一部（温帯以南）
  for (let i = 0; i < n; i++) {
    if (!isLand[i]) continue;
    const t = terrain[i];
    if (t !== 'plain' && t !== 'grass' && t !== 'desert') continue;
    if (Math.abs(latitude(row(i, w), h)) >= 60) continue;
    const nearSea = neighbors(i, w, h).some(j => terrain[j] === 'deep' || terrain[j] === 'shallow');
    if (nearSea && rng() < (inHomeCore[i] ? 0.2 : 0.45)) terrain[i] = 'beach';
  }

  // 海：陸に隣接する海を浅海に（湖は陸ではないので数えない）
  for (let i = 0; i < n; i++) {
    if (terrain[i] !== 'deep') continue;
    if (neighbors(i, w, h).some(j => isLand[j])) terrain[i] = 'shallow';
  }

  const tiles = new Array(n);
  let landCount = 0;
  for (let i = 0; i < n; i++) {
    const t = db.terrain[terrain[i]];
    if (!t) throw new Error(`terrain.json に ${terrain[i]} が無い`);
    if (t.land) landCount++;
    tiles[i] = { c: col(i, w), r: row(i, w), terrain: terrain[i], owner: null, fort: null, facility: null };
  }
  return { tiles, landRatio: landCount / n };
}

function isPassable(db, tiles, i) {
  return !!db.terrain[tiles[i].terrain].passable;
}

/** 通れる（passable）タイルだけを歩いて、start から届く成分を返す */
function component(db, tiles, w, h, start) {
  const seen = new Uint8Array(tiles.length);
  const stack = [start];
  seen[start] = 1;
  while (stack.length) {
    const cur = stack.pop();
    for (const j of neighbors(cur, w, h)) {
      if (seen[j] || !isPassable(db, tiles, j)) continue;
      seen[j] = 1;
      stack.push(j);
    }
  }
  return seen;
}

/** 本拠地を置く。失敗したら null */
function placeHomes(rng, db, tiles, w, h, landIds) {
  const cands = [];
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i].terrain;
    if (t !== 'plain' && t !== 'grass') continue;
    if (colDistFrom(col(i, w), 0, w) > HOME_COL_SPAN) continue;
    if (!inHomeLat(row(i, w), h)) continue;
    cands.push(i);
  }
  if (cands.length < landIds.length) return null;

  // 候補の中でいちばん大きな連結成分だけを使う（本拠地どうしは陸路でつながっている必要がある）
  const compOf = new Map();
  let bestComp = null, bestSize = -1;
  for (const i of cands) {
    if (compOf.has(i)) continue;
    const comp = component(db, tiles, w, h, i);
    let size = 0;
    for (const j of cands) if (comp[j]) { compOf.set(j, comp); size++; }
    if (size > bestSize) { bestSize = size; bestComp = comp; }
  }
  const pool = cands.filter(i => bestComp[i]);
  if (pool.length < landIds.length) return null;

  // 距離 4 以上の 9 つを、候補を経度 0 に近い順に並べたバックトラックで探す
  // （貪欲法だと 6〜7 で止まることが多い）。同じ距離の中の順は rng で揺らして、seed ごとに形を変える
  const order = shuffle(rng, pool).sort((a, b) => colDistFrom(col(a, w), 0, w) - colDistFrom(col(b, w), 0, w));
  const chosen = pickApart(order, landIds.length, HOME_MIN_DIST, w, h, 60000);
  if (!chosen) return null;
  const homes = {};
  landIds.forEach((id, k) => { homes[id] = chosen[k]; });
  return { homes, comp: bestComp };
}

/**
 * order の中から、互いに距離 minDist 以上の count 個を選ぶ（バックトラック）。
 * budget を使い切ったら null
 */
function pickApart(order, count, minDist, w, h, budget) {
  const chosen = [];
  let steps = 0;
  const rec = (start) => {
    if (chosen.length === count) return true;
    for (let k = start; k < order.length; k++) {
      if (++steps > budget) return false;
      // 残りの候補数が足りなければ打ち切る
      if (order.length - k < count - chosen.length) return false;
      const i = order[k];
      let ok = true;
      for (const j of chosen) if (distance(i, j, w, h) < minDist) { ok = false; break; }
      if (!ok) continue;
      chosen.push(i);
      if (rec(k + 1)) return true;
      chosen.pop();
      if (steps > budget) return false;
    }
    return false;
  };
  return rec(0) ? chosen : null;
}

/** 本拠地の群れの中心（c は経度 0 をまたぐので符号付きで平均する） */
function clusterCenter(homes, w, h) {
  const list = Object.values(homes);
  let sc = 0, sr = 0;
  for (const i of list) {
    let c = col(i, w);
    if (c > w / 2) c -= w;
    sc += c;
    sr += row(i, w);
  }
  const c = wrapC(Math.round(sc / list.length), w);
  const r = Math.min(h - 1, Math.max(0, Math.round(sr / list.length)));
  return idx(c, r, w);
}

/** 砦の候補を distance の帯で集める（通れる陸・同じ成分・本拠地から離れている） */
function fortCandidates(db, tiles, w, h, comp, center, range, homeSet, extraFilter) {
  const out = [];
  for (let i = 0; i < tiles.length; i++) {
    if (!comp[i]) continue;
    if (homeSet.has(i)) continue;
    const d = distance(i, center, w, h);
    if (d < range[0] || d > range[1]) continue;
    if (extraFilter && !extraFilter(i)) continue;
    out.push(i);
  }
  return out;
}

function pickSpread(rng, cands, count, taken, w, h) {
  const order = shuffle(rng, cands);
  const chosen = [];
  for (const i of order) {
    if (taken.some(j => distance(i, j, w, h) < FORT_MIN_DIST)) continue;
    if (chosen.some(j => distance(i, j, w, h) < FORT_MIN_DIST)) continue;
    chosen.push(i);
    if (chosen.length === count) break;
  }
  return chosen.length === count ? chosen : null;
}

/** db.enemies を power で並べ、ランクの帯（下 1/3・中 1/3・上 1/3）から選ぶ */
function pickEnemy(rng, enemies, rank) {
  if (!enemies || enemies.length === 0) return null;
  const sorted = enemies.slice().sort((a, b) => (a.power || 0) - (b.power || 0));
  const n = sorted.length;
  const third = Math.max(1, Math.floor(n / 3));
  let lo, hi;
  if (rank === 'rare') { lo = 0; hi = third - 1; }
  else if (rank === 'epic') { lo = third; hi = Math.min(n - 1, 2 * third - 1); }
  else { lo = Math.min(n - 1, 2 * third); hi = n - 1; }
  if (lo > hi) { lo = 0; hi = n - 1; }
  return sorted[rngInt(rng, lo, hi)];
}

function makeFort(rng, db, id, rank, tile) {
  const st = FORT_STATS[rank];
  const enemy = pickEnemy(rng, db.enemies, rank);
  return {
    id,
    rank,
    tile,
    owner: 'enemy',
    troops: st.troops,
    durability: st.durability,
    maxDurability: st.durability,
    enemyId: enemy ? enemy.id : null,
    name: enemy ? `${st.label}砦 ${enemy.name}` : `${st.label}砦`,
    stance: 'defend',
  };
}

/** 1 回ぶんの生成。失敗したら null（理由を reason に） */
function attempt(seed, db, landIds, landBoost) {
  const w = WORLD_W, h = WORLD_H;
  const rng = worldRng(seed);
  const { tiles, landRatio } = buildTerrain(rng, db, w, h, landBoost);

  const placed = placeHomes(rng, db, tiles, w, h, landIds);
  if (!placed) return { reason: 'homes' };
  const { homes, comp } = placed;
  const homeList = Object.values(homes);
  const homeSet = new Set();
  for (const hIdx of homeList) for (const j of within(hIdx, 1, w, h)) homeSet.add(j);

  const center = clusterCenter(homes, w, h);
  const taken = [];

  // Legendary：経度 180°（c が w/2 ずれる）・|緯度| 20〜60°
  const farC = wrapC(col(center, w) + w / 2, w);
  const legendCands = fortCandidates(db, tiles, w, h, comp, center, [0, Infinity], homeSet, (i) => {
    if (colDistFrom(col(i, w), farC, w) > LEGEND_COL_TOL) return false;
    const lat = Math.abs(latitude(row(i, w), h));
    return lat >= LEGEND_LAT[0] && lat <= LEGEND_LAT[1];
  });
  const legend = pickSpread(rng, legendCands, 1, taken, w, h);
  if (!legend) return { reason: 'legendary' };
  taken.push(...legend);

  // Rare 6：中心から 7〜9
  const rareCands = fortCandidates(db, tiles, w, h, comp, center, RARE_RANGE, homeSet);
  const rare = pickSpread(rng, rareCands, 6, taken, w, h);
  if (!rare) return { reason: 'rare' };
  taken.push(...rare);

  // Epic 3：中心から 13〜16
  const epicCands = fortCandidates(db, tiles, w, h, comp, center, EPIC_RANGE, homeSet);
  const epic = pickSpread(rng, epicCands, 3, taken, w, h);
  if (!epic) return { reason: 'epic' };
  taken.push(...epic);

  // 砦と本拠地の持ち主
  const forts = [];
  let fid = 1;
  for (const t of rare) forts.push(makeFort(rng, db, `f${fid++}`, 'rare', t));
  for (const t of epic) forts.push(makeFort(rng, db, `f${fid++}`, 'epic', t));
  for (const t of legend) forts.push(makeFort(rng, db, `f${fid++}`, 'legendary', t));

  for (const [landId, hIdx] of Object.entries(homes)) {
    for (const j of within(hIdx, 1, w, h)) tiles[j].owner = landId;
  }
  for (const f of forts) {
    tiles[f.tile].owner = 'enemy';
    tiles[f.tile].fort = f.id;
  }

  // 念のため、全本拠地から全砦へ通れることを確かめる（成分で選んでいるので通るはず）
  for (const hIdx of homeList) {
    const reach = component(db, tiles, w, h, hIdx);
    for (const f of forts) if (!reach[f.tile]) return { reason: 'disconnected' };
  }

  return { map: { w, h, tiles }, homes, forts, landRatio };
}

/**
 * 世界を生成する。
 * @param {number} seed
 * @param {object} db  少なくとも db.terrain（id → Terrain）と db.enemies（配列。空でもよい）
 * @param {string[]} landIds  9 ランドの id
 * @returns {{ map: {w:number,h:number,tiles:object[]}, homes: Object<string,number>, forts: object[] }}
 */
export function generateWorld(seed, db, landIds) {
  if (!db || !db.terrain) throw new Error('generateWorld: db.terrain が要る');
  if (!Array.isArray(landIds) || landIds.length === 0) throw new Error('generateWorld: landIds が空');
  let landBoost = 0;
  let last = null;
  for (let k = 0; k < MAX_ATTEMPTS; k++) {
    const res = attempt(seed + k, db, landIds, landBoost);
    if (res.map) return { map: res.map, homes: res.homes, forts: res.forts };
    last = res.reason;
    // 足りなければ陸を少し増やす
    landBoost = Math.min(0.15, landBoost + 0.01);
  }
  throw new Error(`generateWorld: ${MAX_ATTEMPTS} 回やり直しても世界を作れなかった（最後の理由: ${last}）`);
}
