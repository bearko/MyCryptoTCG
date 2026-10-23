// バランス班のテスト：砦の陥落直後の保護（turn.js）・CPU の留守番と砦の選び方（ai.js）・通しの数値。
// node --test tests/balance.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDbFromFs } from '../js/data.js';
import { newGame } from '../js/state.js';
import { execute, beginTurn, planCpu, isShielded, FORT_SHIELD_DAYS } from '../js/engine/turn.js';
import { plan } from '../js/engine/ai.js';
import { makeRng } from '../js/engine/rng.js';
import { neighbors } from '../js/engine/hex.js';
import { queue } from '../js/engine/orders.js';
import { upkeep, yields } from '../js/engine/economy.js';

const db = await loadDbFromFs();

/** 砦の隣の、歩けるタイル */
function besideFort(st, fort) {
  const { w, h, tiles } = st.map;
  for (const j of neighbors(fort.tile, w, h)) {
    const t = db.terrain[tiles[j].terrain];
    if (t && t.passable && !tiles[j].fort) return j;
  }
  return null;
}

/** ocean の先頭の部隊を、Rare 砦の隣に立たせる。ほかの部隊はどける */
function setupBeside(seed) {
  const st = newGame({ seed, playerLand: 'ocean', db });
  const fort = Object.values(st.forts).find((f) => f.rank === 'rare' && besideFort(st, f) !== null);
  const tile = besideFort(st, fort);
  const sq = Object.values(st.squads).find((s) => s.land === 'ocean');
  sq.tile = tile;
  sq.policy = 'fight';
  return { st, fort, sq };
}

test('isShielded：落ちた日と翌日（FORT_SHIELD_DAYS = 1）は攻められない', () => {
  const st = newGame({ seed: 3, playerLand: 'ocean', db });
  const f = Object.values(st.forts)[0];
  assert.equal(FORT_SHIELD_DAYS, 1);
  assert.equal(isShielded(st, f), false);
  f.fallenDay = st.day;
  assert.equal(isShielded(st, f), true);
  st.day += 1;
  assert.equal(isShielded(st, f), true);
  st.day += 1;
  assert.equal(isShielded(st, f), false);
});

test('execute：砦が落ちると fort.fallenDay にその日が入る', () => {
  const { st, fort, sq } = setupBeside(4);
  fort.troops = 0;
  fort.durability = 1;
  assert.ok(queue(st, db, sq.id, { type: 'attack', target: fort.tile }).ok);
  const events = [...execute(st, db, makeRng(1))];
  const fallen = events.find((e) => e.t === 'fort_fallen');
  assert.ok(fallen, '砦が落ちる');
  assert.equal(fort.owner, 'ocean');
  // finishDay で day が 1 進むので、fallenDay は前の日
  assert.equal(fort.fallenDay, st.day - 1);
  assert.equal(isShielded(st, fort), true, '翌日もまだ攻められない');
});

test('execute：落ちたばかりの砦への攻撃は blocked(target) で捨てる', () => {
  const { st, fort, sq } = setupBeside(5);
  fort.owner = 'ruby';
  st.map.tiles[fort.tile].owner = 'ruby';
  fort.fallenDay = st.day - 1;
  assert.ok(queue(st, db, sq.id, { type: 'attack', target: fort.tile }).ok);
  const events = [...execute(st, db, makeRng(2))];
  assert.ok(!events.some((e) => e.t === 'battle' && e.attacker === sq.id), '戦闘にならない');
  assert.ok(events.some((e) => e.t === 'blocked' && e.squad === sq.id && e.reason === 'target'));
  assert.equal(fort.owner, 'ruby');
});

test('ai.plan：落ちたばかりの他ランドの砦は狙わない', () => {
  const { st, fort, sq } = setupBeside(6);
  fort.owner = 'ruby';
  st.map.tiles[fort.tile].owner = 'ruby';
  fort.fallenDay = st.day;
  st.lands.ocean.cpu = true;
  plan(st, db, makeRng(3), 'ocean');
  for (const s of Object.values(st.squads)) {
    if (s.land !== 'ocean') continue;
    assert.ok(!s.orders.some((o) => o.type === 'attack' && o.target === fort.tile), `${s.id} が保護中の砦を攻めている`);
  }
  void sq;
});

test('ai.plan：食料が足りなければ、本拠地の部隊が戦わずに農作する（留守番）', () => {
  const st = newGame({ seed: 7, playerLand: 'ocean', db });
  const land = st.lands.ruby;
  land.res.food = 0;
  // 消費が産出を大きく上回っている（初期の兵 lead × 3 が 3 体）
  assert.ok(upkeep(st, db, 'ruby').food > yields(st, db, 'ruby').food);
  plan(st, db, makeRng(4), 'ruby');
  const mine = Object.values(st.squads).filter((s) => s.land === 'ruby');
  const farmers = mine.filter((s) => s.orders.some((o) => o.type === 'domestic' && o.kind === 'farm'));
  assert.ok(farmers.length >= 1, '誰かが農作する');
  // 留守番は攻撃せず、農作を重ねる
  assert.ok(
    farmers.some((s) => !s.orders.some((o) => o.type === 'attack') && s.orders.filter((o) => o.kind === 'farm').length >= 2),
    '農作を重ねる留守番がいる'
  );
  assert.ok(mine.some((s) => s.orders.some((o) => o.type === 'move' || o.type === 'attack')), '全員が留守番にはならない（外へ出る部隊がいる）');
});

test('ai.plan：食料に余裕があれば留守番を置かない', () => {
  // 本拠地とランドの対応は seed で混ざるので、産出が消費を上回るランドを探して使う
  const st = newGame({ seed: 8, playerLand: 'ocean', db });
  let id = null;
  for (const l of Object.values(st.lands)) {
    if (!l.home && l.home !== 0) continue;
    for (const s of Object.values(st.squads)) if (s.land === l.id) s.troops = 10;
    l.res.food = 200;
    l.res.pop = 0;
    if (yields(st, db, l.id).food >= upkeep(st, db, l.id).food) { id = l.id; break; }
  }
  assert.ok(id, '産出が消費を上回るランドがある');
  plan(st, db, makeRng(5), id);
  const farms = Object.values(st.squads)
    .filter((s) => s.land === id)
    .reduce((n, s) => n + s.orders.filter((o) => o.type === 'domestic' && o.kind === 'farm').length, 0);
  assert.equal(farms, 0);
});

test('通し（2 シード × 28 日、全ランド CPU）：飢えと砦の行き来が目標の範囲に収まる', () => {
  for (const seed of [9, 13]) {
    const st = newGame({ seed, playerLand: 'ocean', db });
    for (const l of Object.values(st.lands)) l.cpu = true;
    const rng = makeRng(seed * 7919 + 13);
    let starves = 0;
    let fallen = 0;
    let quick = 0;
    const last = {};
    while (!st.ended && st.day <= 28) {
      planCpu(st, db, rng);
      for (const e of execute(st, db, rng)) {
        if (e.t === 'starve') starves++;
        if (e.t === 'fort_fallen') {
          fallen++;
          if (last[e.fort] !== undefined && st.day - last[e.fort] <= 1) quick++;
          last[e.fort] = st.day;
        }
      }
      if (!st.ended) beginTurn(st, db);
    }
    assert.ok(starves <= 60, `seed ${seed}: 飢え ${starves}（ランド × 日）`);
    assert.ok(fallen <= 50, `seed ${seed}: 落ちた砦 ${fallen}`);
    assert.equal(quick, 0, `seed ${seed}: 落ちた翌日までに取り返された砦がある`);
  }
});
