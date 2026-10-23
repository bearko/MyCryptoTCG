// 検証班のテスト：契約の不変条件を、実データで敵対的に確かめる。node --test tests/verify.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { loadDbFromFs } from '../js/data.js';
import { newGame, serialize, deserialize } from '../js/state.js';
import { beginTurn, planCpu, execute } from '../js/engine/turn.js';
import { makeRng } from '../js/engine/rng.js';
import { neighbors, idx, col, distance } from '../js/engine/hex.js';
import { findPath, reachable } from '../js/engine/pathfind.js';
import { queue } from '../js/engine/orders.js';

const db = await loadDbFromFs();
const W = 48;
const H = 28;

test('neighbors はすべてのタイルで対称（a の隣に b があれば b の隣に a）。東西端もつながる', () => {
  for (let i = 0; i < W * H; i++) {
    const ns = neighbors(i, W, H);
    assert.equal(new Set(ns).size, ns.length);
    for (const n of ns) {
      assert.ok(neighbors(n, W, H).includes(i), `${i} と ${n}`);
      assert.equal(distance(i, n, W, H), 1);
    }
  }
  for (let r = 0; r < H; r++) {
    const westCols = neighbors(idx(0, r, W), W, H).map((i) => col(i, W));
    const eastCols = neighbors(idx(47, r, W), W, H).map((i) => col(i, W));
    assert.ok(westCols.includes(47), `r=${r} の c=0 の隣に c=47`);
    assert.ok(eastCols.includes(0), `r=${r} の c=47 の隣に c=0`);
  }
});

function flatState() {
  const tiles = [];
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) tiles.push({ c, r, terrain: 'plain', owner: null, fort: null, facility: null });
  return { map: { w: W, h: H, tiles }, squads: {}, forts: {}, lands: {} };
}

test('findPath は東西の継ぎ目をまたいで最短を取る（c=1 → c=46 は西へ 3 歩）', () => {
  const st = flatState();
  const hero = db.heroList.find((x) => x.cls && x.cls.main === 'front');
  const sq = { id: 's1', land: 'ocean', tile: idx(1, 10, W) };
  st.squads.s1 = sq;
  const p = findPath(st, db, sq, hero, idx(46, 10, W));
  assert.ok(p);
  assert.equal(p.path.length, 3);
  assert.equal(p.cost, 3);
  const r = reachable(st, db, sq, hero, 2);
  assert.ok(r.has(idx(47, 10, W)) && r.has(idx(0, 10, W)));
});

test('findPath は入れない目的地・囲まれた目的地で null を返して止まる', () => {
  const st = flatState();
  const hero = db.heroList.find((x) => x.cls && x.cls.main === 'front');
  const sq = { id: 's1', land: 'ocean', tile: idx(5, 5, W) };
  st.squads.s1 = sq;
  st.map.tiles[idx(20, 20, W)].terrain = 'deep';
  assert.equal(findPath(st, db, sq, hero, idx(20, 20, W)), null);
  // 目的地のまわりを深海で囲む
  const goal = idx(30, 14, W);
  for (const n of neighbors(goal, W, H)) st.map.tiles[n].terrain = 'deep';
  assert.equal(findPath(st, db, sq, hero, goal), null);
});

// 検証班：execute は beginTurn が決めたこの日の AP で動く（apMax を呼び直して満タンに戻さない）
function longMove(st, sq, minCost) {
  const hero = db.heroes[sq.heroId];
  const seen = new Set([sq.tile]);
  let frontier = [sq.tile];
  for (let d = 0; d < 6; d++) {
    const next = [];
    for (const t of frontier) for (const n of neighbors(t, W, H)) {
      if (seen.has(n)) continue;
      seen.add(n);
      next.push(n);
      const p = findPath(st, db, sq, hero, n);
      if (p && p.cost >= minCost && p.cost <= 12) return p;
    }
    frontier = next;
  }
  return null;
}

test('execute: 奇襲された部隊は、実行フェーズでも AP 半分のまま（翌ターンだけ）', () => {
  const st = newGame({ seed: 11, playerLand: 'ocean', db });
  const b = Object.values(st.squads).find((s) => s.land === 'ocean');
  const full = b.ap;
  b.ambushed = true;
  b.policy = 'ignore';
  beginTurn(st, db);
  const half = b.ap;
  assert.equal(half, Math.ceil(full / 2));
  const p = longMove(st, b, half + 1);
  assert.ok(p, '半分の AP では届かない経路がある');
  assert.ok(queue(st, db, b.id, { type: 'move', path: p.path }).ok);
  const events = [...execute(st, db, makeRng(3))];
  const steps = events.filter((x) => x.t === 'move' && x.squad === b.id).length;
  assert.ok(steps < p.path.length, '途中で止まる');
  assert.ok(events.some((e) => e.t === 'blocked' && e.squad === b.id && e.reason === 'ap'));
  beginTurn(st, db);
  assert.equal(b.ap, full, '翌々ターンは満タンに戻る');
});

test('execute: 敗走明けの部隊は翌ターン動けない（指示を直接積んでも AP 0）、その次は動ける', () => {
  const st = newGame({ seed: 12, playerLand: 'ocean', db });
  const a = Object.values(st.squads).find((s) => s.land === 'ocean');
  const full = a.ap;
  a.status = 'routed';
  a.troops = 0;
  beginTurn(st, db);
  assert.equal(a.ap, 0);
  const p = longMove(st, a, 1);
  assert.ok(p);
  assert.equal(queue(st, db, a.id, { type: 'move', path: p.path }).ok, false, 'AP 0 では積めない');
  a.orders = [{ type: 'move', path: p.path }];
  const home = a.tile;
  const events = [...execute(st, db, makeRng(4))];
  assert.equal(a.tile, home);
  assert.ok(!events.some((e) => e.t === 'move' && e.squad === a.id));
  beginTurn(st, db);
  assert.equal(a.ap, full);
  assert.equal(a.status, 'ok');
});

test('全ランド CPU で 28 日（3 seed）：資源・AP・兵が負にならず整数、state は JSON 往復でき、エネミーの砦が落ちる', () => {
  for (const seed of [7, 8, 9]) {
    const st = newGame({ seed, playerLand: 'ocean', db });
    for (const l of Object.values(st.lands)) l.cpu = true;
    const rng = makeRng(seed * 31 + 1);
    let fromEnemy = 0;
    let guard = 0;
    while (!st.ended && st.day <= 28 && guard++ < 40) {
      planCpu(st, db, rng);
      for (const s of Object.values(st.squads)) assert.ok(s.ap >= 0, `ap ${s.id}`);
      let n = 0;
      for (const e of execute(st, db, rng)) {
        n++;
        if (e.t === 'fort_fallen' && e.from === 'enemy') fromEnemy++;
      }
      assert.ok(n < 100000);
      for (const s of Object.values(st.squads)) {
        assert.ok(s.ap >= 0 && s.troops >= 0 && Number.isFinite(s.troops), `squad ${s.id}`);
      }
      for (const f of Object.values(st.forts)) assert.ok(f.troops >= 0 && f.durability >= 0, `fort ${f.id}`);
      for (const l of Object.values(st.lands)) {
        for (const [k, v] of Object.entries(l.res)) assert.ok(Number.isInteger(v) && v >= 0, `${seed} day ${st.day} ${l.id}.${k}=${v}`);
      }
      const j = serialize(st);
      assert.equal(serialize(deserialize(j)), j);
      if (!st.ended) beginTurn(st, db);
    }
    assert.ok(st.ended, `seed ${seed} は終わる`);
    assert.ok(fromEnemy >= 3, `seed ${seed}: CPU がエネミーの砦を落とす（${fromEnemy}）`);
  }
});

const ENGINE_DIR = new URL('../js/engine/', import.meta.url);
function engineSources() {
  return readdirSync(ENGINE_DIR).filter((f) => f.endsWith('.js')).map((f) => {
    const src = readFileSync(new URL(f, ENGINE_DIR), 'utf8');
    // コメントを除く（「Math.random は使わない」と書いたコメントは許す）
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    return { f, code };
  });
}

test('js/engine は DOM・localStorage・Math.random・Date.now を使わない', () => {
  for (const { f, code } of engineSources()) {
    assert.ok(!/\bMath\.random\b|\bDate\.now\b|\bnew Date\b|\bdocument\b|\bwindow\b|\blocalStorage\b|\bperformance\b/.test(code), f);
  }
});

test('js/engine に unit / gold / ユニット / 金銭 / ゴールド の識別子や文言が残っていない', () => {
  for (const { f, code } of engineSources()) {
    for (const l of code.split('\n')) assert.ok(!/\bunits?\b|\bunitId\b|\bUnit\b|\bgold\b|ユニット|金銭|ゴールド/.test(l), `${f}: ${l.trim()}`);
  }
});
