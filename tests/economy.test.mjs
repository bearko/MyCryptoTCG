// economy 班のテスト：economy.js。node --test tests/economy.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  caps, yields, upkeep, applyDaily, canBuild, startBuild, tickBuilds, domestic, rest, terrainYield,
} from '../js/engine/economy.js';
import { TROOPS_PER_FOOD as D } from '../js/engine/tuning.js';

const read = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), 'utf8'));
const terrainList = read('../data/terrain.json');
const facilityList = read('../data/facilities.json');
const extList = read('../data/extensions.json');

const HERO = {
  id: 1, name: 'テスト', rarity: 1, cls: { main: 'front', sub: 'vanguard' },
  params: { act: 10, lead: 20, str: 5, int: 10, gov: 25, pol: 12 },
};
const db = {
  terrain: Object.fromEntries(terrainList.map((t) => [t.id, t])),
  facilities: Object.fromEntries(facilityList.map((f) => [f.id, f])),
  heroes: { 1: HERO },
  heroList: [HERO],
  extensions: Object.fromEntries(extList.map((e) => [e.id, e])),
};

const W = 8;
const H = 6;
// c3,r2 = 19 の隣接は 20, 11, 10, 18, 26, 27
const C = 19;

function makeState() {
  const tiles = [];
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) tiles.push({ c, r, terrain: 'plain', owner: null, fort: null, facility: null });
  }
  return {
    version: 1, seed: 1, day: 1, phase: 'orders', playerLand: 'ocean',
    map: { w: W, h: H, tiles },
    lands: {
      ocean: {
        id: 'ocean', cpu: false, alive: true, home: C,
        res: { pop: 100, food: 150, gum: 120, mat: 60 },
        explored: [], souls: [], extensions: [], fortPoints: 0,
        points: { week1: 0, week2: 0, week3: 0, week4: 0 },
      },
    },
    squads: {
      u1: { id: 'u1', heroId: 1, land: 'ocean', tile: C, troops: 50, ap: 11, orders: [], policy: 'ask', status: 'ok', equip: null, ambushed: false },
    },
    forts: {}, builds: {}, nextId: 2, log: [], notices: [], pending: [], ended: null,
  };
}

function own(state, list, land = 'ocean') {
  for (const i of list) state.map.tiles[i].owner = land;
}

test('terrain の gum を産出として読む', () => {
  assert.deepEqual(terrainYield(db, 'grass'), { food: 2, gum: 1, mat: 0 });
  assert.deepEqual(terrainYield(db, 'mountain'), { food: 0, gum: 0, mat: 3 });
});

test('caps: 基本値 + 施設の上限 × ランク', () => {
  const s = makeState();
  assert.deepEqual(caps(s, db, 'ocean'), { pop: 100, food: 200, mat: 100 });
  own(s, [C, 20, 11]);
  s.map.tiles[C].facility = { kind: 'lodge', rank: 2 };
  s.map.tiles[20].facility = { kind: 'granary', rank: 1 };
  s.map.tiles[11].facility = { kind: 'storage', rank: 3 };
  assert.deepEqual(caps(s, db, 'ocean'), { pop: 160, food: 300, mat: 340 });
  // 他ランドの施設は数えない
  s.map.tiles[11].owner = 'ruby';
  assert.equal(caps(s, db, 'ocean').mat, 100);
});

test('yields: 地形の産出 + 自然増 round(pop 上限 × 1%)', () => {
  const s = makeState();
  own(s, [C, 20]);
  s.map.tiles[20].terrain = 'grass';
  // plain 1/1/0 + grass 2/1/0、pop は round(100 × 0.01) = 1
  assert.deepEqual(yields(s, db, 'ocean'), { pop: 1, food: 3, gum: 2, mat: 0 });
});

test('yields: farm は terrainAdj、ランクで倍', () => {
  const s = makeState();
  own(s, [C]);
  s.map.tiles[C].terrain = 'grass';
  s.map.tiles[C].facility = { kind: 'farm', rank: 2 };
  // 地形 2 + (4 + 1) × 2 = 12
  assert.equal(yields(s, db, 'ocean').food, 12);
  s.map.tiles[C].terrain = 'desert';
  s.map.tiles[C].facility.rank = 1;
  // 地形 0 + (4 − 2) × 1 = 2
  assert.equal(yields(s, db, 'ocean').food, 2);
});

test('yields: mine は隣接する山岳・火山 1 つにつき +1', () => {
  const s = makeState();
  own(s, [C]);
  s.map.tiles[C].facility = { kind: 'mine', rank: 1 };
  s.map.tiles[20].terrain = 'mountain';
  s.map.tiles[11].terrain = 'volcano';
  s.map.tiles[10].terrain = 'cliff';
  // (3 + 2) × 1。山は占領していないので地形の産出は入らない
  assert.equal(yields(s, db, 'ocean').mat, 5);
});

test('yields: town は gum +4 と、隣接する街以外の施設の産出 +1', () => {
  const s = makeState();
  own(s, [C, 20, 11]);
  s.map.tiles[C].facility = { kind: 'town', rank: 1 };
  s.map.tiles[20].facility = { kind: 'farm', rank: 1 };
  s.map.tiles[11].facility = { kind: 'lodge', rank: 1 }; // 産出が無いので補正も無い
  const y = yields(s, db, 'ocean');
  // food: 地形 1×3 + farm 4 + 街の補正 1 = 8
  assert.equal(y.food, 8);
  // gum: 地形 1×3 + town 4 = 7
  assert.equal(y.gum, 7);
  // pop 上限 100 + 40 + 30 = 170 → 自然増 2
  assert.equal(y.pop, 2);
});

test('upkeep: floor(人口 / 10) + floor(兵 / d)（d は tuning.js のつまみ）', () => {
  const s = makeState();
  s.lands.ocean.res.pop = 95;
  s.squads.u1.troops = 52;
  assert.deepEqual(upkeep(s, db, 'ocean'), { food: 9 + Math.floor(52 / D) });
  // 兵が d の倍数をまたぐところで 1 増える
  s.squads.u1.troops = 5 * D - 1;
  assert.equal(upkeep(s, db, 'ocean').food, 9 + 4);
  s.squads.u1.troops = 5 * D;
  assert.equal(upkeep(s, db, 'ocean').food, 9 + 5);
});

test('applyDaily: 産出 → 消費 → 上限、yield は実際の増減', () => {
  const s = makeState();
  own(s, [C]);
  s.lands.ocean.res = { pop: 100, food: 150, gum: 120, mat: 99 };
  s.map.tiles[C].facility = { kind: 'mine', rank: 1 };
  const ev = applyDaily(s, db, 'ocean');
  // pop は上限 100 で止まる。food 150 + 1 − (10 + floor(50 / d))。gum +1。mat 99 + 3 → 100 で止まる
  const eat = 10 + Math.floor(50 / D);
  assert.deepEqual(s.lands.ocean.res, { pop: 100, food: 151 - eat, gum: 121, mat: 100 });
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0], { t: 'yield', land: 'ocean', res: { pop: 0, food: 1 - eat, gum: 1, mat: 1 } });
});

test('applyDaily: 食料が足りないと 0 にして starve（shortfall つき）。兵は減らさず、人口の自然増もない（SPEC-113 §2）', () => {
  const s = makeState();
  s.lands.ocean.res = { pop: 90, food: 5, gum: 0, mat: 0 };
  s.squads.u1.troops = 55;
  s.squads.u2 = { ...s.squads.u1, id: 'u2', troops: 9 };
  s.squads.r1 = { ...s.squads.u1, id: 'r1', land: 'ruby', troops: 40 };
  const ev = applyDaily(s, db, 'ocean');
  // 消費 floor(90 / 10) + floor(64 / d)。足りない量は 消費 − 5
  const short = 9 + Math.floor(64 / D) - 5;
  assert.ok(short > 0, '足りなくなる前提');
  assert.equal(s.lands.ocean.res.food, 0);
  assert.equal(s.squads.u1.troops, 55); // 即時の罰（兵 × 0.9）はやめた
  assert.equal(s.squads.u2.troops, 9);
  assert.equal(s.squads.r1.troops, 40);
  assert.equal(s.lands.ocean.res.pop, 90); // 自然増 +1 は無し・人口 × 0.95 もしない
  assert.deepEqual(ev, [
    { t: 'yield', land: 'ocean', res: { pop: 0, food: -5, gum: 0, mat: 0 } },
    { t: 'starve', land: 'ocean', shortfall: short },
  ]);
});

test('canBuild: 自ランドの占領地・建てられる地形・費用', () => {
  const s = makeState();
  let r = canBuild(s, db, 'ocean', C, 'farm');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'owner');
  own(s, [C, 20, 11]);
  r = canBuild(s, db, 'ocean', C, 'farm');
  assert.deepEqual(r, { ok: true, reason: null, cost: { gum: 20, mat: 10 }, days: 2, toRank: 1 });
  s.map.tiles[20].terrain = 'swamp';
  assert.equal(canBuild(s, db, 'ocean', 20, 'farm').reason, 'terrain');
  s.map.tiles[11].terrain = 'beach';
  assert.equal(canBuild(s, db, 'ocean', 11, 'mine').reason, 'terrain');
  assert.equal(canBuild(s, db, 'ocean', C, 'nope').reason, 'kind');
  s.lands.ocean.res.mat = 5;
  assert.equal(canBuild(s, db, 'ocean', C, 'farm').reason, 'mat');
  s.lands.ocean.res.gum = 5;
  assert.equal(canBuild(s, db, 'ocean', C, 'farm').reason, 'gum');
});

test('canBuild: 街は水に隣接が要る', () => {
  const s = makeState();
  own(s, [C]);
  assert.equal(canBuild(s, db, 'ocean', C, 'town').reason, 'water');
  s.map.tiles[27].terrain = 'shallow';
  assert.equal(canBuild(s, db, 'ocean', C, 'town').ok, true);
  s.map.tiles[27].terrain = 'river';
  assert.equal(canBuild(s, db, 'ocean', C, 'town').ok, true);
});

test('canBuild: 同じ施設はランク上げ（3 まで）、別の施設・建築中・砦は不可', () => {
  const s = makeState();
  own(s, [C]);
  s.map.tiles[C].facility = { kind: 'farm', rank: 2 };
  assert.equal(canBuild(s, db, 'ocean', C, 'farm').toRank, 3);
  assert.equal(canBuild(s, db, 'ocean', C, 'mine').reason, 'other');
  s.map.tiles[C].facility.rank = 3;
  assert.equal(canBuild(s, db, 'ocean', C, 'farm').reason, 'rank');
  s.map.tiles[C].facility = null;
  s.builds[C] = { tileIdx: C, kind: 'farm', land: 'ocean', daysLeft: 1, toRank: 1 };
  assert.equal(canBuild(s, db, 'ocean', C, 'farm').reason, 'building');
  delete s.builds[C];
  s.map.tiles[C].fort = 'f1';
  assert.equal(canBuild(s, db, 'ocean', C, 'farm').reason, 'fort');
});

test('canBuild: 日数は統治力で縮む（部隊を渡したとき）', () => {
  const s = makeState();
  own(s, [C]);
  s.map.tiles[27].terrain = 'lake';
  // town 3 日 − floor(25 / 10) = 1
  assert.equal(canBuild(s, db, 'ocean', C, 'town', s.squads.u1).days, 1);
  assert.equal(canBuild(s, db, 'ocean', C, 'town').days, 3);
  // 装備の gov は無いので、hero の gov を 9 にすると縮まない
  const s2 = makeState();
  own(s2, [C]);
  const db2 = { ...db, heroes: { 1: { ...HERO, params: { ...HERO.params, gov: 9 } } } };
  assert.equal(canBuild(s2, db2, 'ocean', C, 'farm', s2.squads.u1).days, 2);
});

test('startBuild → tickBuilds で施設になる', () => {
  const s = makeState();
  own(s, [C]);
  const db2 = { ...db, heroes: { 1: { ...HERO, params: { ...HERO.params, gov: 0 } } } };
  const ev = startBuild(s, db2, s.squads.u1, 'farm', 0);
  assert.deepEqual(ev, { t: 'build_start', squad: 'u1', tile: C, kind: 'farm', days: 2 });
  assert.equal(s.lands.ocean.res.gum, 100);
  assert.equal(s.lands.ocean.res.mat, 50);
  assert.deepEqual(s.builds[C], { tileIdx: C, kind: 'farm', land: 'ocean', daysLeft: 2, toRank: 1 });
  assert.deepEqual(tickBuilds(s, db2), []);
  assert.equal(s.builds[C].daysLeft, 1);
  assert.deepEqual(tickBuilds(s, db2), [{ t: 'build_done', tile: C, kind: 'farm', rank: 1, land: 'ocean' }]);
  assert.deepEqual(s.map.tiles[C].facility, { kind: 'farm', rank: 1 });
  assert.equal(s.builds[C], undefined);
});

test('startBuild: rush で縮む（最短 1 日）、建てられなければ blocked で何も変えない', () => {
  const s = makeState();
  own(s, [C]);
  const db2 = { ...db, heroes: { 1: { ...HERO, params: { ...HERO.params, gov: 0 } } } };
  assert.equal(startBuild(s, db2, s.squads.u1, 'farm', 5).days, 1);
  const before = JSON.stringify(s);
  const ev = startBuild(s, db2, s.squads.u1, 'farm', 0); // 建築中
  assert.deepEqual(ev, { t: 'blocked', squad: 'u1', at: C, reason: 'build' });
  assert.equal(JSON.stringify(s), before);
});

test('tickBuilds: 占領されたタイルの建築は消える', () => {
  const s = makeState();
  own(s, [C]);
  startBuild(s, db, s.squads.u1, 'farm', 0);
  s.map.tiles[C].owner = 'ruby';
  assert.deepEqual(tickBuilds(s, db), []);
  assert.deepEqual(s.builds, {});
  assert.equal(s.map.tiles[C].facility, null);
});

test('domestic: conscript は min(floor(pop × 0.3), 兵の上限 − いまの兵)', () => {
  const s = makeState();
  s.lands.ocean.res.pop = 95;
  const ev = domestic(s, db, s.squads.u1, 'conscript');
  assert.deepEqual(ev, { t: 'domestic', squad: 'u1', kind: 'conscript', amount: 28 });
  assert.equal(s.lands.ocean.res.pop, 67);
  assert.equal(s.squads.u1.troops, 78);
  s.squads.u1.troops = 195; // 上限 lead 20 × 10 = 200
  assert.equal(domestic(s, db, s.squads.u1, 'conscript').amount, 5);
  assert.equal(s.squads.u1.troops, 200);
  // 装備の troopCap と lead は上限に効く
  s.squads.u1.equip = 'ext_artofwar'; // lead +3 → 上限 230
  s.lands.ocean.res.pop = 200;
  assert.equal(domestic(s, db, s.squads.u1, 'conscript').amount, 30);
});

test('domestic: farm / trade / craft（food・mat は上限で止まる）', () => {
  const s = makeState();
  s.lands.ocean.res = { pop: 100, food: 150, gum: 0, mat: 60 };
  assert.equal(domestic(s, db, s.squads.u1, 'farm').amount, 35);
  assert.equal(s.lands.ocean.res.food, 185);
  assert.equal(domestic(s, db, s.squads.u1, 'farm').amount, 15); // 上限 200
  assert.equal(s.lands.ocean.res.food, 200);
  assert.equal(domestic(s, db, s.squads.u1, 'trade').amount, 20);
  assert.equal(s.lands.ocean.res.gum, 20);
  assert.equal(domestic(s, db, s.squads.u1, 'craft').amount, 18); // 6 + floor(25 / 2)
  assert.equal(s.lands.ocean.res.mat, 78);
});

test('rest: 統率力 × 2、本拠地なら ×2、定員で止まる。増えた兵の分だけ人口を使い、士気 +10', () => {
  const s = makeState();
  // 定員（集めた兵）190・上限（統率力 20 × 10）200。休息は戦いで減った兵を定員まで戻すだけ（SPEC-113 §2.1）
  s.squads.u1.troops = 100;
  s.squads.u1.mustered = 190;
  s.squads.u1.morale = 60;
  assert.deepEqual(rest(s, db, s.squads.u1), {
    t: 'rest', squad: 'u1', amount: 80,
    morale: { t: 'morale', squad: 'u1', delta: 10, reason: 'rest', value: 70 },
  });
  assert.equal(s.lands.ocean.res.pop, 20); // 100 − 80
  s.squads.u1.tile = 20;
  // 本拠地の外：統率力 × 2 = 40 だが、定員まで 10 しか空いていない
  assert.equal(rest(s, db, s.squads.u1).amount, 10);
  assert.equal(s.squads.u1.troops, 190);
  assert.equal(s.lands.ocean.res.pop, 10, '定員で止まった分の人口は残る');
  assert.equal(rest(s, db, s.squads.u1).amount, 0, '定員に届いたら上限（200）に余裕があっても増えない');
  assert.equal(s.squads.u1.troops, 190);
  assert.equal(s.squads.u1.mustered, 190, '休息は定員を変えない');
  assert.equal(s.lands.ocean.res.pop, 10);
  assert.equal(s.squads.u1.morale, 90);
});

test('rest: 定員が上限より大きければ上限で止まる。mustered の無い部隊は今の兵が定員', () => {
  const s = makeState();
  s.squads.u1.troops = 150;
  s.squads.u1.mustered = 400; // 装備を外したなどで上限（200）が定員より小さい
  assert.equal(rest(s, db, s.squads.u1).amount, 50);
  assert.equal(s.squads.u1.troops, 200);
  assert.equal(rest(s, db, s.squads.u1).amount, 0);
  // 古い state（mustered なし）：今の兵を定員とみなすので増えない
  const t = makeState();
  t.squads.u1.troops = 100;
  delete t.squads.u1.mustered;
  assert.equal(rest(t, db, t.squads.u1).amount, 0);
  assert.equal(t.lands.ocean.res.pop, 100);
});

test('rest: 人口が足りなければ足りる分だけ、人口 0 なら増えない', () => {
  const s = makeState();
  s.squads.u1.troops = 100;
  s.squads.u1.mustered = 200;
  s.lands.ocean.res.pop = 30;
  assert.equal(rest(s, db, s.squads.u1).amount, 30);
  assert.equal(s.squads.u1.troops, 130);
  assert.equal(s.lands.ocean.res.pop, 0);
  assert.equal(rest(s, db, s.squads.u1).amount, 0);
  assert.equal(s.squads.u1.troops, 130);
});
