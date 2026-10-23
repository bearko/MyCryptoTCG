// worldgen.js のテスト。固定データ（terrain.json / lands.json）を読んで世界を作る
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateWorld, FORT_STATS } from '../js/engine/worldgen.js';
import { col, row, wrapC, idx, neighbors, distance, within, latitude } from '../js/engine/hex.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(here, '..', p), 'utf8'));

const terrainList = readJson('data/terrain.json');
const landDefs = readJson('data/lands.json');
const landIds = landDefs.map(l => l.id);

// enemies.json は heroes 班の生成物なので、ここでは形だけ合わせた 30 体を作る
const enemies = Array.from({ length: 30 }, (_, k) => ({
  id: 300 + k, name: `エネミー${k}`, image: `Image/Enemies/${k}.png`, power: 20 + k * 10,
}));

const db = { terrain: Object.fromEntries(terrainList.map(t => [t.id, t])), enemies };
const dbNoEnemies = { terrain: db.terrain, enemies: [] };

const W = 48, H = 28;

/** 本拠地の群れの中心（worldgen と同じ考え方：c は経度 0 をまたぐので符号付きで平均） */
function center(homes) {
  const list = Object.values(homes);
  let sc = 0, sr = 0;
  for (const i of list) {
    let c = col(i, W);
    if (c > W / 2) c -= W;
    sc += c; sr += row(i, W);
  }
  return idx(wrapC(Math.round(sc / list.length), W), Math.round(sr / list.length), W);
}

function colDist(a, b) {
  const d = Math.abs(wrapC(a - b, W));
  return Math.min(d, W - d);
}

/** passable だけを歩いて start から届く集合 */
function reach(tiles, start) {
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length) {
    const cur = stack.pop();
    for (const j of neighbors(cur, W, H)) {
      if (seen.has(j) || !db.terrain[tiles[j].terrain].passable) continue;
      seen.add(j);
      stack.push(j);
    }
  }
  return seen;
}

const SEEDS = [1, 2, 3, 7, 42, 2026];

for (const seed of SEEDS) {
  test(`seed ${seed}: 48×28 の世界ができ、陸は 25〜45%`, () => {
    const { map } = generateWorld(seed, db, landIds);
    assert.equal(map.w, W);
    assert.equal(map.h, H);
    assert.equal(map.tiles.length, W * H);
    let land = 0;
    const kinds = new Set();
    map.tiles.forEach((t, i) => {
      assert.equal(t.c, col(i, W));
      assert.equal(t.r, row(i, W));
      assert.ok(db.terrain[t.terrain], `未知の地形 ${t.terrain}`);
      assert.equal(t.facility, null);
      kinds.add(t.terrain);
      if (db.terrain[t.terrain].land) land++;
    });
    const ratio = land / map.tiles.length;
    assert.ok(ratio >= 0.25 && ratio <= 0.45, `陸の割合 ${ratio}`);
    // 主な地形がひととおり出ている
    for (const k of ['plain', 'grass', 'mountain', 'shallow', 'deep', 'beach', 'ice']) {
      assert.ok(kinds.has(k), `${k} が無い`);
    }
    // 浅海は陸に隣接し、深海は陸に隣接しない
    map.tiles.forEach((t, i) => {
      if (t.terrain !== 'shallow' && t.terrain !== 'deep') return;
      const nearLand = neighbors(i, W, H).some(j => db.terrain[map.tiles[j].terrain].land);
      assert.equal(nearLand, t.terrain === 'shallow', `${t.terrain} @${i}`);
    });
  });

  test(`seed ${seed}: 本拠地 9 つ（plain/grass・距離 4 以上・経度 0 付近の温帯・周囲 1 が占領地）`, () => {
    const { map, homes } = generateWorld(seed, db, landIds);
    assert.deepEqual(Object.keys(homes).sort(), [...landIds].sort());
    const list = Object.values(homes);
    assert.equal(new Set(list).size, 9);
    for (const i of list) {
      assert.ok(['plain', 'grass'].includes(map.tiles[i].terrain), `本拠地 ${i} が ${map.tiles[i].terrain}`);
      assert.ok(colDist(col(i, W), 0) <= 10, `経度 0 から遠い c=${col(i, W)}`);
      const lat = latitude(row(i, W), H);
      assert.ok(lat >= 20 && lat <= 60, `緯度 ${lat}`);
    }
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        assert.ok(distance(list[a], list[b], W, H) >= 4, `本拠地が近すぎる ${list[a]} ${list[b]}`);
      }
    }
    for (const [landId, i] of Object.entries(homes)) {
      for (const j of within(i, 1, W, H)) assert.equal(map.tiles[j].owner, landId);
      assert.equal(map.tiles[i].fort, null);
    }
  });

  test(`seed ${seed}: 砦 10 個（Rare 6 / Epic 3 / Legendary 1）と距離帯`, () => {
    const { map, homes, forts } = generateWorld(seed, db, landIds);
    assert.equal(forts.length, 10);
    assert.deepEqual(forts.map(f => f.id), Array.from({ length: 10 }, (_, k) => `f${k + 1}`));
    const byRank = { rare: [], epic: [], legendary: [] };
    for (const f of forts) byRank[f.rank].push(f);
    assert.equal(byRank.rare.length, 6);
    assert.equal(byRank.epic.length, 3);
    assert.equal(byRank.legendary.length, 1);

    const c = center(homes);
    const homeTiles = new Set(Object.values(homes));
    const tilesTaken = new Set();
    for (const f of forts) {
      const st = FORT_STATS[f.rank];
      assert.equal(f.owner, 'enemy');
      assert.equal(f.stance, 'defend');
      assert.equal(f.troops, st.troops);
      assert.equal(f.durability, st.durability);
      assert.equal(f.maxDurability, st.durability);
      assert.ok(f.name.startsWith(`${st.label}砦 `), f.name);
      assert.ok(db.terrain[map.tiles[f.tile].terrain].passable, `砦が通れない地形 ${map.tiles[f.tile].terrain}`);
      assert.equal(map.tiles[f.tile].owner, 'enemy');
      assert.equal(map.tiles[f.tile].fort, f.id);
      assert.ok(!homeTiles.has(f.tile));
      assert.ok(!tilesTaken.has(f.tile), '砦が重なっている');
      tilesTaken.add(f.tile);
      const d = distance(f.tile, c, W, H);
      if (f.rank === 'rare') assert.ok(d >= 7 && d <= 9, `Rare 砦の距離 ${d}`);
      if (f.rank === 'epic') assert.ok(d >= 13 && d <= 16, `Epic 砦の距離 ${d}`);
    }
    // Legendary は経度でおおむね 180° 離れている（c が w/2 ずれる・± 5 列）
    const lg = byRank.legendary[0];
    assert.ok(colDist(col(lg.tile, W), col(c, W)) >= W / 2 - 5, `Legendary の経度のずれ ${colDist(col(lg.tile, W), col(c, W))}`);
    const lat = Math.abs(latitude(row(lg.tile, W), H));
    assert.ok(lat >= 20 && lat <= 60, `Legendary の緯度 ${lat}`);
    // 砦の守備は enemies の power の帯から選ばれる（rare 下 1/3・epic 中 1/3・legendary 上 1/3）
    const sorted = enemies.slice().sort((a, b) => a.power - b.power);
    const rankOf = (id) => sorted.findIndex(e => e.id === id);
    for (const f of forts) {
      const k = rankOf(f.enemyId);
      assert.ok(k >= 0, `enemyId ${f.enemyId} が無い`);
      if (f.rank === 'rare') assert.ok(k < 10);
      if (f.rank === 'epic') assert.ok(k >= 10 && k < 20);
      if (f.rank === 'legendary') assert.ok(k >= 20);
      assert.ok(f.name.endsWith(sorted[k].name));
    }
  });

  test(`seed ${seed}: 全本拠地から全砦へ陸路（passable）でつながる`, () => {
    const { map, homes, forts } = generateWorld(seed, db, landIds);
    for (const [landId, home] of Object.entries(homes)) {
      const r = reach(map.tiles, home);
      for (const f of forts) assert.ok(r.has(f.tile), `${landId} から ${f.id} へ届かない`);
      for (const other of Object.values(homes)) assert.ok(r.has(other));
    }
  });
}

test('同じ seed なら同じ世界、違う seed なら違う世界', () => {
  const a = generateWorld(5, db, landIds);
  const b = generateWorld(5, db, landIds);
  assert.deepEqual(a, b);
  const c = generateWorld(6, db, landIds);
  assert.notDeepEqual(a.map.tiles.map(t => t.terrain), c.map.tiles.map(t => t.terrain));
});

test('db.enemies が空でも作れる（enemyId は null・名前はランクだけ）', () => {
  const { forts } = generateWorld(3, dbNoEnemies, landIds);
  assert.equal(forts.length, 10);
  for (const f of forts) {
    assert.equal(f.enemyId, null);
    assert.equal(f.name, `${FORT_STATS[f.rank].label}砦`);
  }
});

test('landIds が空なら Error', () => {
  assert.throws(() => generateWorld(1, db, []));
});

test('いろいろな seed で 50 回以内に作れる（30 seed）', () => {
  for (let seed = 100; seed < 130; seed++) {
    const { forts, homes } = generateWorld(seed, dbNoEnemies, landIds);
    assert.equal(forts.length, 10);
    assert.equal(Object.keys(homes).length, 9);
  }
});
