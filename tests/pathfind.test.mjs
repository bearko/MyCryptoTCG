// pathfind.js のテスト。小さな手作りの map（幅 8 × 高さ 6・東西ループ）で確かめる
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stepCost, findPath, reachable } from '../js/engine/pathfind.js';
import { idx, col, row, neighbors } from '../js/engine/hex.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const terrainList = JSON.parse(fs.readFileSync(path.join(here, '..', 'data', 'terrain.json'), 'utf8'));
const db = { terrain: Object.fromEntries(terrainList.map(t => [t.id, t])) };

const W = 8, H = 6;

// 1 文字 = 1 タイル。行ごとに 8 文字
const CH = {
  '.': 'plain', '"': 'grass', 'd': 'desert', 'r': 'river', 'M': 'mountain', 'V': 'volcano',
  'c': 'cliff', '~': 'deep', 's': 'swamp', 'i': 'ice', 'b': 'beach',
};

function makeMap(rows) {
  assert.equal(rows.length, H);
  const tiles = [];
  for (let r = 0; r < H; r++) {
    assert.equal(rows[r].length, W);
    for (let c = 0; c < W; c++) {
      tiles.push({ c, r, terrain: CH[rows[r][c]], owner: null, fort: null, facility: null });
    }
  }
  return { w: W, h: H, tiles };
}

function makeState(rows, extra = {}) {
  return {
    version: 1, seed: 1, day: 1, phase: 'orders', playerLand: 'ocean',
    map: makeMap(rows),
    lands: {}, squads: {}, forts: {}, builds: {}, nextId: 1, log: [], notices: [], pending: [], ended: null,
    ...extra,
  };
}

const hero = (main, sub) => ({ id: 1, cls: { main, sub } });
const FRONT = hero('front', 'striker');
const SCOUT = hero('front', 'scout');
const VANGUARD = hero('front', 'vanguard');
const MID = hero('mid', 'gunner');
const BACK = hero('back', 'sniper');

const squadAt = (tile, land = 'ocean', id = 's1') => ({
  id, heroId: 1, land, tile, troops: 50, ap: 7, orders: [], policy: 'ask', status: 'ok', equip: null, ambushed: false,
});

// 基本の盤面。行 2 が主な通り道。列 3 に山、列 5 に河、列 6 に砂漠
const BASIC = [
  '........',
  '."."....',
  '...M.rd.',
  '...M.rd.',
  '..~~....',
  '........',
];

test('stepCost: 地形のコスト（土 1・草原は前衛 1、他は 1.5・砂漠 2・河川 3）', () => {
  const st = makeState(BASIC);
  const sq = squadAt(idx(0, 2, W));
  assert.equal(stepCost(st, db, sq, FRONT, idx(1, 2, W)), 1);
  assert.equal(stepCost(st, db, sq, FRONT, idx(1, 1, W)), 1);     // 草原・前衛
  assert.equal(stepCost(st, db, sq, MID, idx(1, 1, W)), 1.5);     // 草原・中衛
  assert.equal(stepCost(st, db, sq, BACK, idx(1, 1, W)), 1.5);    // 草原・後衛
  assert.equal(stepCost(st, db, sq, FRONT, idx(6, 2, W)), 2);     // 砂漠
  assert.equal(stepCost(st, db, sq, FRONT, idx(5, 2, W)), 3);     // 河川
});

test('stepCost: 山岳・火山は先鋒・偵察だけ scoutCost、他は Infinity。崖・海は誰も通れない', () => {
  const rows = ['........', '..MV....', '..c~....', '........', '........', '........'];
  const st = makeState(rows);
  const sq = squadAt(idx(0, 0, W));
  assert.equal(stepCost(st, db, sq, FRONT, idx(2, 1, W)), Infinity);
  assert.equal(stepCost(st, db, sq, MID, idx(2, 1, W)), Infinity);
  assert.equal(stepCost(st, db, sq, SCOUT, idx(2, 1, W)), 3);
  assert.equal(stepCost(st, db, sq, VANGUARD, idx(2, 1, W)), 3);
  assert.equal(stepCost(st, db, sq, SCOUT, idx(3, 1, W)), 3);          // 火山
  assert.equal(stepCost(st, db, sq, SCOUT, idx(2, 2, W)), Infinity);   // 崖
  assert.equal(stepCost(st, db, sq, SCOUT, idx(3, 2, W)), Infinity);   // 深海
  assert.equal(stepCost(st, db, sq, FRONT, 9999), Infinity);           // 盤面の外
});

test('stepCost: 敵部隊・敵の砦・敵の本拠地のタイルは Infinity。味方なら通れる', () => {
  const st = makeState(BASIC);
  const me = squadAt(idx(0, 0, W));
  const enemyTile = idx(1, 0, W);
  const friendTile = idx(2, 0, W);
  const enemyFortTile = idx(0, 1, W);
  const myFortTile = idx(1, 1, W);
  const enemyHome = idx(2, 1, W);
  st.squads = { s1: me, s2: squadAt(enemyTile, 'ruby', 's2'), s3: squadAt(friendTile, 'ocean', 's3') };
  st.forts = {
    f1: { id: 'f1', rank: 'rare', tile: enemyFortTile, owner: 'enemy', troops: 60, durability: 40, maxDurability: 40, enemyId: null, name: 'Rare砦', stance: 'defend' },
    f2: { id: 'f2', rank: 'rare', tile: myFortTile, owner: 'ocean', troops: 30, durability: 20, maxDurability: 40, enemyId: null, name: 'Rare砦', stance: 'defend' },
  };
  st.map.tiles[enemyFortTile].fort = 'f1'; st.map.tiles[enemyFortTile].owner = 'enemy';
  st.map.tiles[myFortTile].fort = 'f2'; st.map.tiles[myFortTile].owner = 'ocean';
  st.lands = { ocean: { id: 'ocean', home: idx(0, 0, W) }, ruby: { id: 'ruby', home: enemyHome } };
  assert.equal(stepCost(st, db, me, FRONT, enemyTile), Infinity);
  assert.equal(stepCost(st, db, me, FRONT, friendTile), 1);
  assert.equal(stepCost(st, db, me, FRONT, enemyFortTile), Infinity);
  assert.equal(stepCost(st, db, me, FRONT, myFortTile), 1);
  assert.equal(stepCost(st, db, me, FRONT, enemyHome), Infinity);
  // ruby の部隊から見ると逆になる
  const foe = st.squads.s2;
  assert.equal(stepCost(st, db, foe, FRONT, friendTile), Infinity);
  assert.equal(stepCost(st, db, foe, FRONT, enemyHome), 1);
  assert.equal(stepCost(st, db, foe, FRONT, idx(0, 0, W)), Infinity);  // ocean の本拠地（me がいる）
});

test('findPath: まっすぐな道はコストが歩数ぶん。path に今いるタイルは含まず、末尾が目的地', () => {
  const st = makeState(BASIC);
  const sq = squadAt(idx(0, 0, W));
  const res = findPath(st, db, sq, FRONT, idx(2, 0, W));
  assert.ok(res);
  assert.deepEqual(res.path, [idx(1, 0, W), idx(2, 0, W)]);
  assert.equal(res.cost, 2);
  // path は隣どうし
  let prev = sq.tile;
  for (const t of res.path) { assert.ok(neighbors(prev, W, H).includes(t)); prev = t; }
});

test('findPath: 今いるタイルが目的地なら空の path', () => {
  const st = makeState(BASIC);
  const sq = squadAt(idx(0, 0, W));
  assert.deepEqual(findPath(st, db, sq, FRONT, sq.tile), { path: [], cost: 0 });
});

test('findPath: 山岳を避けて回り道する。偵察なら山を越える', () => {
  // 行 2 で (2,2) → (4,2)。間の (3,2) は山。(3,1)・(3,3) は土
  const rows = ['........', '........', '...M....', '........', '........', '........'];
  const st = makeState(rows);
  const sq = squadAt(idx(2, 2, W));
  const r1 = findPath(st, db, sq, FRONT, idx(4, 2, W));
  assert.ok(r1);
  assert.ok(!r1.path.includes(idx(3, 2, W)));
  assert.equal(r1.cost, 3);   // 回り道で 3 歩
  const r2 = findPath(st, db, sq, SCOUT, idx(4, 2, W));
  assert.ok(r2);
  assert.equal(r2.cost, 3);   // 山越え 3 + 1 = 4 より回り道 3 のほうが安い
  assert.ok(!r2.path.includes(idx(3, 2, W)));
  // 山を目的地にできるのは偵察だけ
  assert.equal(findPath(st, db, sq, FRONT, idx(3, 2, W)), null);
  const r3 = findPath(st, db, sq, SCOUT, idx(3, 2, W));
  assert.deepEqual(r3, { path: [idx(3, 2, W)], cost: 3 });
});

test('findPath: 東西のループを使って近道する', () => {
  // (0,2) → (7,2) は西へ 1 歩（c=-1 → 7）。中央には何も無いが 7 歩かかる
  const st = makeState(BASIC.map(() => '........'));
  const sq = squadAt(idx(0, 2, W));
  const res = findPath(st, db, sq, FRONT, idx(7, 2, W));
  assert.ok(res);
  assert.deepEqual(res.path, [idx(7, 2, W)]);
  assert.equal(res.cost, 1);
  // 河川をまたいで東へ行くより、西からループしたほうが安い盤面
  const rows2 = ['~~~~~~~~', '~~~~~~~~', '..rrrr..', '~~~~~~~~', '~~~~~~~~', '~~~~~~~~'];
  const st2 = makeState(rows2);
  const s2 = squadAt(idx(1, 2, W));
  const res2 = findPath(st2, db, s2, FRONT, idx(6, 2, W));
  assert.ok(res2);
  assert.deepEqual(res2.path, [idx(0, 2, W), idx(7, 2, W), idx(6, 2, W)]);
  assert.equal(res2.cost, 3);
});

test('findPath: 高いコストの地形を避けて、合計が最小の道を選ぶ', () => {
  // 行 1 が砂漠（2）、行 2 が河（3）、行 0 が土。(0,1) → (3,1) は砂漠を直進すると 2+2+2=6、
  // 行 0 を通って最後だけ砂漠に降りると 1+1+1+2=5
  const rows = ['........', 'dddddddd', 'rrrrrrrr', '~~~~~~~~', '~~~~~~~~', '~~~~~~~~'];
  const st = makeState(rows);
  const sq = squadAt(idx(0, 1, W));
  const res = findPath(st, db, sq, FRONT, idx(3, 1, W));
  assert.ok(res);
  assert.equal(res.cost, 5);
  assert.equal(res.path.filter(t => row(t, W) === 0).length, 3);
  // 合計が stepCost の和になっている
  let sum = 0;
  for (const t of res.path) sum += stepCost(st, db, sq, FRONT, t);
  assert.equal(sum, res.cost);
});

test('findPath: 届かないなら null（島・敵のタイル）', () => {
  // (4,0) は海に囲まれた島（東西のループでも届かない）
  const rows = ['..~~.~~~', '~~~~~~~~', '~~~~~~~~', '~~~~~~~~', '~~~~~~~~', '~~~~~~~~'];
  const st = makeState(rows);
  const sq = squadAt(idx(0, 0, W));
  assert.equal(findPath(st, db, sq, FRONT, idx(4, 0, W)), null);
  assert.equal(findPath(st, db, sq, FRONT, idx(3, 0, W)), null);   // 海そのもの
  assert.equal(findPath(st, db, sq, FRONT, idx(1, 0, W)).cost, 1); // 隣の陸には届く
  // 敵部隊が目的地
  const st2 = makeState(BASIC);
  const me = squadAt(idx(0, 0, W));
  st2.squads = { s1: me, s2: squadAt(idx(1, 0, W), 'ruby', 's2') };
  assert.equal(findPath(st2, db, me, FRONT, idx(1, 0, W)), null);
  // 敵部隊が一本道をふさぐ
  const rows3 = ['....~~~~', '~~~~~~~~', '~~~~~~~~', '~~~~~~~~', '~~~~~~~~', '~~~~~~~~'];
  const st3 = makeState(rows3);
  const me3 = squadAt(idx(0, 0, W));
  st3.squads = { s1: me3, s2: squadAt(idx(2, 0, W), 'ruby', 's2') };
  assert.equal(findPath(st3, db, me3, FRONT, idx(3, 0, W)), null);
  // 味方ならふさがない
  st3.squads.s2.land = 'ocean';
  assert.equal(findPath(st3, db, me3, FRONT, idx(3, 0, W)).cost, 3);
});

test('findPath: 大きめの盤面でも A* の答えが Dijkstra（reachable）と一致する', () => {
  const rows = ['.."".d..', '.M.."r..', '..~~.r..', '.c..dd..', '"".M....', '........'];
  const st = makeState(rows);
  const sq = squadAt(idx(0, 5, W));
  for (const hero of [FRONT, MID, SCOUT]) {
    const all = reachable(st, db, sq, hero, 100);
    for (let i = 0; i < W * H; i++) {
      const res = findPath(st, db, sq, hero, i);
      if (all.has(i)) {
        assert.ok(res, `${i} へ届くはず`);
        assert.equal(res.cost, all.get(i), `${i} のコスト`);
      } else {
        assert.equal(res, null, `${i} へは届かないはず`);
      }
    }
  }
});

test('reachable: AP 以内のタイルだけ。今いるタイルは 0', () => {
  const rows = ['........', '........', '..dM....', '........', '........', '........'];
  const st = makeState(rows);
  const sq = squadAt(idx(1, 2, W));
  const r = reachable(st, db, sq, FRONT, 2);
  assert.equal(r.get(sq.tile), 0);
  // 隣の土は 1、砂漠 (2,2) は 2、山 (3,2) は入れない
  assert.equal(r.get(idx(0, 2, W)), 1);
  assert.equal(r.get(idx(2, 2, W)), 2);
  assert.ok(!r.has(idx(3, 2, W)));
  for (const [i, c] of r) {
    assert.ok(c <= 2, `${i} のコスト ${c}`);
    assert.ok(row(i, W) >= 0 && col(i, W) >= 0);
  }
  // AP 0 なら自分だけ
  assert.deepEqual([...reachable(st, db, sq, FRONT, 0).keys()], [sq.tile]);
  // AP が増えると広がる
  assert.ok(reachable(st, db, sq, FRONT, 3).size > r.size);
  // 山の先 (4,2) へは (1,1)→(2,1)→(3,1)→(4,2) の 4 歩。AP 3 では届かない
  assert.ok(!reachable(st, db, sq, FRONT, 3).has(idx(4, 2, W)));
  assert.equal(reachable(st, db, sq, FRONT, 4).get(idx(4, 2, W)), 4);
});

test('reachable: 東西のループで広がる', () => {
  const st = makeState(BASIC.map(() => '........'));
  const sq = squadAt(idx(0, 2, W));
  const r = reachable(st, db, sq, FRONT, 1);
  assert.equal(r.get(idx(7, 2, W)), 1);
  assert.equal(r.get(idx(1, 2, W)), 1);
  assert.equal(r.size, 7);   // 自分 + 隣 6
});
