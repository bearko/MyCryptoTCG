// economy 班のテスト：orders.js。node --test tests/orders.test.mjs
//
// orders.js は battle.js の inRange を import する。battle.js がまだ無いあいだは
// このファイルのテストは全部 skip になる（読み込みに失敗するため）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const battlePath = new URL('../js/engine/battle.js', import.meta.url);
const hasBattle = fs.existsSync(battlePath);
const O = hasBattle ? await import('../js/engine/orders.js') : null;
const skip = hasBattle ? false : 'js/engine/battle.js がまだ無い（battle 班の作業待ち）';

const read = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), 'utf8'));
const terrainList = read('../data/terrain.json');
const facilityList = read('../data/facilities.json');
const extList = read('../data/extensions.json');

const VAN = {
  id: 1, name: '先鋒', rarity: 1, cls: { main: 'front', sub: 'vanguard' },
  params: { act: 10, lead: 20, str: 5, int: 10, gov: 0, pol: 12 },
};
const GUARD = {
  id: 2, name: '重装', rarity: 1, cls: { main: 'front', sub: 'guard' },
  params: { act: 7, lead: 20, str: 5, int: 10, gov: 0, pol: 12 },
};
const SNIPER = {
  id: 3, name: '射撃', rarity: 1, cls: { main: 'back', sub: 'sniper' },
  params: { act: 6, lead: 20, str: 5, int: 10, gov: 0, pol: 12 },
};
const db = {
  terrain: Object.fromEntries(terrainList.map((t) => [t.id, t])),
  facilities: Object.fromEntries(facilityList.map((f) => [f.id, f])),
  heroes: { 1: VAN, 2: GUARD, 3: SNIPER },
  heroList: [VAN, GUARD, SNIPER],
  extensions: Object.fromEntries(extList.map((e) => [e.id, e])),
};

const W = 8;
const H = 6;
const C = 19; // c3,r2。隣接は 20, 11, 10, 18, 26, 27。20 の東隣は 21

function sq(id, heroId, land, tile, ap) {
  return { id, heroId, land, tile, troops: 50, ap, orders: [], policy: 'ask', status: 'ok', equip: null, ambushed: false };
}

function makeState() {
  const tiles = [];
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) tiles.push({ c, r, terrain: 'plain', owner: null, fort: null, facility: null });
  }
  for (const i of [C, 20, 11, 10, 18, 26, 27]) tiles[i].owner = 'ocean';
  const land = (id, home) => ({
    id, cpu: id !== 'ocean', alive: true, home,
    res: { pop: 100, food: 150, gum: 120, mat: 60 },
    explored: [], souls: [], extensions: [], fortPoints: 0,
    points: { week1: 0, week2: 0, week3: 0, week4: 0 },
  });
  return {
    version: 1, seed: 1, day: 1, phase: 'orders', playerLand: 'ocean',
    map: { w: W, h: H, tiles },
    lands: { ocean: land('ocean', C), ruby: land('ruby', 44) },
    squads: { u1: sq('u1', 1, 'ocean', C, 11) },
    forts: {}, builds: {}, nextId: 2, log: [], notices: [], pending: [], ended: null,
  };
}

test('apMax: act + 小分類の増減 + 装備、routed 0、ambushed は半分（切り上げ）', { skip }, () => {
  const s = sq('x', 1, 'ocean', C, 0);
  assert.equal(O.apMax(VAN, s, db), 11);
  assert.equal(O.apMax(GUARD, s, db), 6);
  assert.equal(O.apMax(SNIPER, s, db), 6);
  s.equip = 'ext_boots';
  assert.equal(O.apMax(VAN, s, db), 12);
  s.ambushed = true;
  assert.equal(O.apMax(GUARD, s, db), 4); // ceil(7 / 2)
  s.status = 'routed';
  assert.equal(O.apMax(VAN, s, db), 0);
});

test('apCost: move は経路の合計、固定の AP、rest は残り全部', { skip }, () => {
  const s = makeState();
  s.map.tiles[20].terrain = 'desert';
  const u = s.squads.u1;
  assert.equal(O.apCost(s, db, u, { type: 'move', path: [20, 21] }), 3);
  assert.equal(O.apCost(s, db, u, { type: 'claim' }), 1);
  assert.equal(O.apCost(s, db, u, { type: 'build', kind: 'farm', rush: 3 }), 5);
  assert.equal(O.apCost(s, db, u, { type: 'attack', target: 20 }), 2);
  assert.equal(O.apCost(s, db, u, { type: 'domestic', kind: 'farm' }), 2);
  assert.equal(O.apCost(s, db, u, { type: 'rest' }), 11);
  s.map.tiles[21].terrain = 'deep';
  assert.equal(O.apCost(s, db, u, { type: 'move', path: [20, 21] }), Infinity);
});

test('validate move: 隣接の連鎖で、各タイルに入れること', { skip }, () => {
  const s = makeState();
  const u = s.squads.u1;
  assert.equal(O.validate(s, db, u, { type: 'move', path: [20, 21] }).ok, true);
  assert.equal(O.validate(s, db, u, { type: 'move', path: [21] }).reason, 'path');
  assert.equal(O.validate(s, db, u, { type: 'move', path: [] }).reason, 'path');
  assert.equal(O.validate(s, db, u, { type: 'move', path: [20, 20] }).reason, 'path');
  // 敵ランドの部隊がいるタイルには入れない（pathfind.stepCost が Infinity）
  s.squads.r1 = sq('r1', 1, 'ruby', 20, 11);
  assert.equal(O.validate(s, db, u, { type: 'move', path: [20, 21] }).reason, 'terrain');
  delete s.squads.r1;
  s.map.tiles[21].terrain = 'mountain';
  // 先鋒は山岳を 3 で通れる
  assert.equal(O.validate(s, db, u, { type: 'move', path: [20, 21] }).ok, true);
  s.squads.u1.heroId = 2;
  assert.equal(O.validate(s, db, s.squads.u1, { type: 'move', path: [20, 21] }).reason, 'terrain');
});

test('queue move: AP を超える移動も積める（ap は 0 で止める）', { skip }, () => {
  const s = makeState();
  const u = s.squads.u1;
  u.ap = 2;
  const path = [20, 21, 22, 23];
  assert.deepEqual(O.queue(s, db, 'u1', { type: 'move', path }), { ok: true, reason: null });
  assert.equal(u.ap, 0);
  assert.equal(u.orders.length, 1);
  assert.deepEqual(u.orders[0].path, path);
  assert.equal(O.plannedAp(s, db, u), 4);
  // AP 0 ではもう積めない
  assert.equal(O.queue(s, db, 'u1', { type: 'claim' }).reason, 'ap');
  O.clearOrders(s, 'u1');
  assert.equal(u.ap, 2);
  assert.deepEqual(u.orders, []);
});

test('移動のあとの位置で検証する（移動 → 占領）', { skip }, () => {
  const s = makeState();
  const u = s.squads.u1;
  // 本拠地は自ランドなので占領できない
  assert.equal(O.validate(s, db, u, { type: 'claim' }).reason, 'claim');
  assert.equal(O.queue(s, db, 'u1', { type: 'move', path: [20, 21] }).ok, true);
  assert.equal(u.ap, 9);
  // 次の移動は 21 から続ける
  assert.equal(O.validate(s, db, u, { type: 'move', path: [20] }).ok, true);
  assert.equal(O.validate(s, db, u, { type: 'move', path: [19] }).reason, 'path');
  assert.equal(O.queue(s, db, 'u1', { type: 'claim' }).ok, true);
  assert.equal(u.ap, 8);
  assert.equal(O.plannedAp(s, db, u), 3);
  // 移動したあとは本拠地にいないので内政はできない
  assert.equal(O.validate(s, db, u, { type: 'domestic', kind: 'farm' }).reason, 'home');
});

test('validate claim: 自ランド・砦・敵のいるタイルは不可、他ランドの空きタイルは可', { skip }, () => {
  const s = makeState();
  const u = s.squads.u1;
  u.tile = 21;
  assert.equal(O.validate(s, db, u, { type: 'claim' }).ok, true);
  s.map.tiles[21].owner = 'ruby';
  assert.equal(O.validate(s, db, u, { type: 'claim' }).ok, true);
  s.map.tiles[21].fort = 'f1';
  s.map.tiles[21].owner = 'enemy';
  assert.equal(O.validate(s, db, u, { type: 'claim' }).reason, 'claim');
});

test('validate build: canBuild を通す、AP は 2 + rush', { skip }, () => {
  const s = makeState();
  const u = s.squads.u1;
  assert.equal(O.validate(s, db, u, { type: 'build', kind: 'farm', rush: 0 }).ok, true);
  const r = O.validate(s, db, u, { type: 'build', kind: 'town', rush: 0 });
  assert.equal(r.reason, 'build');
  assert.equal(r.buildReason, 'water');
  assert.equal(O.validate(s, db, u, { type: 'build', kind: 'farm', rush: 10 }).reason, 'ap');
  assert.equal(O.queue(s, db, 'u1', { type: 'build', kind: 'farm', rush: 9 }).ok, true);
  assert.equal(u.ap, 0);
  // 自ランドでないタイルへ移動してからの開拓は不可
  const s2 = makeState();
  O.queue(s2, db, 'u1', { type: 'move', path: [20, 21] });
  assert.equal(O.validate(s2, db, s2.squads.u1, { type: 'build', kind: 'farm', rush: 0 }).buildReason, 'owner');
});

test('validate domestic: 本拠地だけ、kind を確かめる', { skip }, () => {
  const s = makeState();
  const u = s.squads.u1;
  assert.equal(O.validate(s, db, u, { type: 'domestic', kind: 'conscript' }).ok, true);
  assert.equal(O.validate(s, db, u, { type: 'domestic', kind: 'magic' }).reason, 'kind');
  u.tile = 20;
  assert.equal(O.validate(s, db, u, { type: 'domestic', kind: 'trade' }).reason, 'home');
});

test('queue rest: 残りの AP を全部使う、clearOrders で戻る', { skip }, () => {
  const s = makeState();
  const u = s.squads.u1;
  O.queue(s, db, 'u1', { type: 'claim' }); // 自ランドなので不可
  assert.equal(u.ap, 11);
  O.queue(s, db, 'u1', { type: 'domestic', kind: 'farm' });
  assert.equal(u.ap, 9);
  assert.equal(O.queue(s, db, 'u1', { type: 'rest' }).ok, true);
  assert.equal(u.ap, 0);
  assert.equal(O.plannedAp(s, db, u), 11);
  assert.equal(O.queue(s, db, 'u1', { type: 'rest' }).reason, 'ap');
  O.clearOrders(s, 'u1');
  assert.equal(u.ap, 11);
});

test('queue: 未知の指示・未知の部隊は積まない', { skip }, () => {
  const s = makeState();
  assert.equal(O.queue(s, db, 'u1', { type: 'fly' }).reason, 'type');
  assert.equal(O.queue(s, db, 'nope', { type: 'rest' }).reason, 'squad');
  assert.equal(s.squads.u1.ap, 11);
});

test('validate attack: 敵がいて、射程内（battle.inRange）', { skip }, () => {
  const s = makeState();
  s.squads.r1 = sq('r1', 1, 'ruby', 21, 11); // 19 から距離 2
  const u = s.squads.u1;
  assert.equal(O.validate(s, db, u, { type: 'attack', target: 20 }).reason, 'target');
  // 先鋒の射程は 1
  assert.equal(O.validate(s, db, u, { type: 'attack', target: 21 }).reason, 'range');
  // 射撃の射程は 3
  s.squads.u1.heroId = 3;
  assert.equal(O.validate(s, db, s.squads.u1, { type: 'attack', target: 21 }).ok, true);
  // 先鋒でも、隣まで移動してからなら届く
  s.squads.u1.heroId = 1;
  O.queue(s, db, 'u1', { type: 'move', path: [20] });
  assert.equal(O.validate(s, db, s.squads.u1, { type: 'attack', target: 21 }).ok, true);
  // 他ランドの本拠地も敵
  assert.equal(O.validate(s, db, sq('x', 3, 'ocean', 36, 6), { type: 'attack', target: 44 }).ok, true);
  // 敵の砦
  s.forts.f1 = { id: 'f1', tile: 22, owner: 'enemy' };
  assert.equal(O.validate(s, db, sq('y', 3, 'ocean', 20, 6), { type: 'attack', target: 22 }).ok, true);
});

// ---------------------------------------------------------------- undoLast（SPEC-114 §4「1 手戻す」）

test('undoLast: 最後の指示だけ外し、その AP を戻す（何度でも。空なら none で何もしない）', { skip }, () => {
  const s = makeState();
  const u = s.squads.u1;
  assert.deepEqual(O.undoLast(s, 'u1'), { ok: false, reason: 'none' });
  assert.equal(u.ap, 11);
  assert.equal(O.queue(s, db, 'u1', { type: 'domestic', kind: 'farm' }).ok, true);
  assert.equal(O.queue(s, db, 'u1', { type: 'domestic', kind: 'trade' }).ok, true);
  assert.equal(O.queue(s, db, 'u1', { type: 'move', path: [20, 21] }).ok, true);
  assert.equal(O.queue(s, db, 'u1', { type: 'claim' }).ok, true);
  assert.equal(u.ap, 4);
  const first = u.orders.slice(0, 3).map((o) => ({ ...o }));
  // 最後の占領（AP 1）だけが外れる
  const r = O.undoLast(s, 'u1');
  assert.equal(r.ok, true);
  assert.equal(r.reason, null);
  assert.equal(r.order.type, 'claim');
  assert.equal(r.ap, 1);
  assert.equal(u.ap, 5);
  assert.deepEqual(u.orders, first);
  // 移動を外すと、立っている位置（projectedTile）も戻る
  assert.equal(O.projectedTile(u), 21);
  assert.equal(O.undoLast(s, 'u1').order.type, 'move');
  assert.equal(O.projectedTile(u), C);
  assert.equal(u.ap, 7);
  assert.equal(O.undoLast(s, 'u1').order.kind, 'trade');
  assert.equal(O.undoLast(s, 'u1').order.kind, 'farm');
  assert.equal(u.ap, 11);
  assert.deepEqual(u.orders, []);
  assert.equal(O.undoLast(s, 'u1').reason, 'none');
  assert.equal(u.ap, 11);
});

test('undoLast: 休息（残りの AP 全部）・AP 0 で止めた移動は、実際に引いた AP だけ戻す', { skip }, () => {
  const s = makeState();
  const u = s.squads.u1;
  O.queue(s, db, 'u1', { type: 'domestic', kind: 'farm' });
  O.queue(s, db, 'u1', { type: 'rest' });
  assert.equal(u.ap, 0);
  assert.equal(O.undoLast(s, 'u1').ap, 9);
  assert.equal(u.ap, 9);
  // AP 2 で 4 マスの移動を積むと 2 だけ引く。外すと 2 だけ戻る（経路の本来のコスト 4 ではない）
  u.ap = 2;
  u.orders = [];
  O.queue(s, db, 'u1', { type: 'move', path: [20, 21, 22, 23] });
  assert.equal(u.ap, 0);
  const r = O.undoLast(s, 'u1');
  assert.equal(r.ap, 2);
  assert.equal(u.ap, 2);
  // ap の無い指示（古いセーブ）は AP を戻さずに外す。未知の部隊は squad
  u.orders = [{ type: 'claim' }];
  assert.equal(O.undoLast(s, 'u1').ap, 0);
  assert.equal(u.ap, 2);
  assert.deepEqual(u.orders, []);
  assert.deepEqual(O.undoLast(s, 'nope'), { ok: false, reason: 'squad' });
});

test('undoLast と clearOrders: 1 つずつ戻しても、まとめて戻しても AP は同じ', { skip }, () => {
  const a = makeState();
  const b = makeState();
  for (const s of [a, b]) {
    O.queue(s, db, 'u1', { type: 'domestic', kind: 'farm' });
    O.queue(s, db, 'u1', { type: 'move', path: [20] });
    O.queue(s, db, 'u1', { type: 'claim' });
  }
  while (O.undoLast(a, 'u1').ok) { /* 全部外す */ }
  O.clearOrders(b, 'u1');
  assert.equal(a.squads.u1.ap, b.squads.u1.ap);
  assert.equal(a.squads.u1.ap, 11);
  assert.deepEqual(a.squads.u1.orders, b.squads.u1.orders);
});
