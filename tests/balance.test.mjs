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
  // 消費が産出を大きく上回っている（初期の兵 統率力 × k が 3 体）
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

// ---------------------------------------------------------------- SPEC-113 §5 の目標（2 シード・範囲を少し緩めて）
//
// プレイヤーのランド（ocean）を決め打ちの方針で 28 日、ほかは CPU（tools/sim-lib.mjs の runPlayer / runCpu。
// tools/sim.mjs --player と同じもの）。決めた値（k / d / m）と、その根拠の数字は SPEC-113 §5 の末尾の表。
// 「何もしない」の「食料 6 日以上」は、ほかの目標と同時には満たせない（理由は SPEC-113 §5 の表の下）。
// ここでは決めた値で実際に出る「4 日以上」と「全滅しない」を確かめる。

import { runPlayer, runCpu } from '../tools/sim-lib.mjs';
import { TUNING } from '../js/engine/tuning.js';

const GOAL_SEEDS = [3, 4];

test('SPEC-113 §5：つまみは調整の範囲の中', () => {
  assert.ok(TUNING.k >= 1 && TUNING.k <= 3, `k ${TUNING.k}`);
  assert.ok(TUNING.d >= 5 && TUNING.d <= 12, `d ${TUNING.d}`);
  assert.ok(TUNING.m >= 1 && TUNING.m <= 2, `m ${TUNING.m}`);
});

test('SPEC-113 §5 何もしない：食料は 4 日以上もち、尽きても 28 日目まで部隊が全滅しない', () => {
  for (const seed of GOAL_SEEDS) {
    const r = runPlayer(db, seed, 'none');
    assert.ok(r.foodOut === null || r.foodOut >= 4, `seed ${seed}: 食料が尽きた日 ${r.foodOut}`);
    assert.ok(r.alive && r.squadsAlive >= 1, `seed ${seed}: 全滅（兵のいる部隊 ${r.squadsAlive}）`);
  }
});

test('SPEC-113 §5 毎日 1 人だけ農作を 1 回：1 日目の差し引きが −15〜+10/日（目標 −10〜+5）', () => {
  for (const seed of GOAL_SEEDS) {
    const r = runPlayer(db, seed, 'farm1');
    assert.ok(r.flow1 >= -15 && r.flow1 <= 10, `seed ${seed}: 差し引き ${r.flow1}`);
    assert.equal(r.flow1, r.net1, `seed ${seed}: 上限に届かないので「このあと」と流れは同じ`);
  }
});

test('SPEC-113 §5 毎日 1 人が農作を AP いっぱい：差し引き +10/日 以上で、食料が尽きない', () => {
  for (const seed of GOAL_SEEDS) {
    const r = runPlayer(db, seed, 'farmMax');
    assert.ok(r.flow1 >= 10, `seed ${seed}: 流れ ${r.flow1}`);
    assert.ok(r.net1 >= 0, `seed ${seed}: 「このあと」${r.net1}（食料の上限で止まっても赤字にはならない）`);
    assert.equal(r.foodOut, null, `seed ${seed}: 食料が尽きた（${r.foodOut} 日目）`);
  }
});

test('SPEC-113 §5 毎日 2 回ずつ徴兵：3〜10 日目に食料が尽きる（目標 4〜8 日目）', () => {
  for (const seed of GOAL_SEEDS) {
    const r = runPlayer(db, seed, 'conscript2');
    assert.ok(r.foodOut !== null && r.foodOut >= 3 && r.foodOut <= 10, `seed ${seed}: 食料が尽きた日 ${r.foodOut}`);
  }
});

test('SPEC-113 §5 全ランド CPU：4 シードで、飢え 40 以下・逃走で兵 0 の部隊 2 以下（シードごと）、落ちた砦は平均で 12〜45（目標 30 / 1 / 平均 15〜40）', () => {
  // 落ちた砦はシードごとのぶれが大きい（seed 1〜20 で 9〜29）。SPEC-113 §5 の目標は「1 シード平均」なので平均で見る
  const fallen = [];
  for (const seed of [...GOAL_SEEDS, 5, 6]) {
    const r = runCpu(db, seed);
    fallen.push(r.fallen);
    assert.ok(r.starves <= 40, `seed ${seed}: 飢え ${r.starves}`);
    assert.ok(r.zeroed <= 2, `seed ${seed}: 逃走で兵 0 の部隊 ${r.zeroed}`);
  }
  const avg = fallen.reduce((a, b) => a + b, 0) / fallen.length;
  assert.ok(avg >= 12 && avg <= 45, `落ちた砦 平均 ${avg}（${fallen.join(', ')}）`);
});
