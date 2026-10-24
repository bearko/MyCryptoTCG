// SPEC-113（士気と食料）のテスト：morale.js・economy.js の見込み・turn.finishDay の順番・orders・ai・state。
// node --test tests/morale.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { loadDbFromFs } from '../js/data.js';
import { newGame, serialize, deserialize } from '../js/state.js';
import { beginTurn, planCpu, execute, finishDay, noticesFrom, targetAt } from '../js/engine/turn.js';
import { predict, resolve, inRange } from '../js/engine/battle.js';
import { plan } from '../js/engine/ai.js';
import { makeRng } from '../js/engine/rng.js';
import { queue, validate } from '../js/engine/orders.js';
import { neighbors, within } from '../js/engine/hex.js';
import {
  upkeep, applyDaily, domestic, troopFood, setRation, breakdown, forecast, previewDomestic, previewRation,
  moraleMult, DOMESTIC_KINDS, rewardCost,
} from '../js/engine/economy.js';
import { applyNight, planNight, MORALE_START, DESERT_RATE } from '../js/engine/morale.js';
import { troopCap } from '../js/engine/heroes.js';
import { TUNING, START_TROOPS_PER_LEAD, TROOPS_PER_FOOD, FARM_PER_GOV } from '../js/engine/tuning.js';

const D = TROOPS_PER_FOOD;

const read = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), 'utf8'));
const realDb = await loadDbFromFs();

// ---------------------------------------------------------------- 手作りの小さな state

const P = { act: 10, lead: 20, str: 5, int: 0, gov: 25, pol: 12 };
const H = (id, sub, main) => ({ id, name: `H${id}`, rarity: 1, cls: { main, sub }, params: { ...P }, skill: null });
const heroes = [H(1, 'vanguard', 'front'), H(2, 'commander', 'front'), H(3, 'healer', 'back'), H(4, 'support', 'mid')];
const db = {
  terrain: Object.fromEntries(read('../data/terrain.json').map((t) => [t.id, t])),
  facilities: Object.fromEntries(read('../data/facilities.json').map((f) => [f.id, f])),
  heroes: Object.fromEntries(heroes.map((h) => [h.id, h])),
  heroList: heroes,
  extensions: Object.fromEntries(read('../data/extensions.json').map((e) => [e.id, e])),
  lands: [{ id: 'ocean', nameJa: 'オーシャン' }],
  messages: { tones: [], messages: {}, ui: {} },
};
const W = 8;
const HH = 6;
const C = 19; // c3,r2。隣は 20, 11, 10, 18, 26, 27
const FAR = 0; // 本拠地から離れたタイル（19 とも 20 とも隣でない）

function makeState() {
  const tiles = [];
  for (let r = 0; r < HH; r++) for (let c = 0; c < W; c++) tiles.push({ c, r, terrain: 'plain', owner: null, fort: null, facility: null });
  return {
    version: 1, seed: 1, day: 1, phase: 'orders', playerLand: 'ocean',
    map: { w: W, h: HH, tiles },
    lands: {
      ocean: {
        id: 'ocean', cpu: false, alive: true, home: C, res: { pop: 100, food: 150, gum: 120, mat: 60 },
        explored: [], souls: [], extensions: [], fortPoints: 0, points: { week1: 0, week2: 0, week3: 0, week4: 0 }, ration: 'normal',
      },
    },
    squads: {}, forts: {}, builds: {}, nextId: 10, log: [], notices: [], pending: [], ended: null,
  };
}

function add(st, id, heroId, tile, extra = {}) {
  st.squads[id] = { id, heroId, land: 'ocean', tile, troops: 50, ap: 11, orders: [], policy: 'ask', status: 'ok', equip: null, ambushed: false, morale: 60, ...extra };
  return st.squads[id];
}

const byT = (events, t) => events.filter((e) => e.t === t);

// ---------------------------------------------------------------- つまみ

test('つまみ k / d / m は tuning.js の 1 か所にあり、SPEC-113 §5 の「決めた値」のまま', () => {
  assert.deepEqual(TUNING, { k: 2, d: 9, m: 1 });
  assert.equal(START_TROOPS_PER_LEAD, 2);
  assert.equal(TROOPS_PER_FOOD, 9);
  assert.equal(FARM_PER_GOV, 1);
});

// ---------------------------------------------------------------- 士気係数・初期値

test('moraleMult：0 → 0.75、50 → 1.00、100 → 1.25、無ければ 60 扱い', () => {
  assert.equal(moraleMult(0), 0.75);
  assert.equal(moraleMult(50), 1);
  assert.equal(moraleMult(100), 1.25);
  assert.ok(Math.abs(moraleMult(undefined) - 1.05) < 1e-12);
  assert.equal(MORALE_START, 60);
});

test('newGame：部隊は士気 60・兵は統率力 × k、ランドの配給は normal', () => {
  const st = newGame({ seed: 2, playerLand: 'ocean', db: realDb });
  for (const s of Object.values(st.squads)) {
    assert.equal(s.morale, 60);
    assert.equal(s.troops, realDb.heroes[s.heroId].params.lead * START_TROOPS_PER_LEAD);
  }
  for (const l of Object.values(st.lands)) assert.equal(l.ration, 'normal');
});

test('deserialize：古いセーブ（morale / ration 無し）は既定値で読む', () => {
  const st = newGame({ seed: 3, playerLand: 'ocean', db: realDb });
  const old = JSON.parse(serialize(st));
  for (const s of Object.values(old.squads)) delete s.morale;
  for (const l of Object.values(old.lands)) delete l.ration;
  old.squads[Object.keys(old.squads)[0]].morale = 12; // あるものは残す
  const back = deserialize(JSON.stringify(old));
  const list = Object.values(back.squads);
  assert.equal(list[0].morale, 12);
  assert.ok(list.slice(1).every((s) => s.morale === 60));
  assert.ok(Object.values(back.lands).every((l) => l.ration === 'normal'));
});

// ---------------------------------------------------------------- 1 日の終わりの士気（§1.1・§1.2）

test('finishDay：食料が足りた日は +2、本拠地で夜を越すと +3', () => {
  const st = makeState();
  add(st, 'u1', 1, C);
  add(st, 'u2', 1, FAR);
  const ev = finishDay(st, db);
  assert.equal(st.squads.u1.morale, 65);
  assert.equal(st.squads.u2.morale, 62);
  const md = byT(ev, 'morale_day')[0];
  assert.deepEqual(md.changes.find((c) => c.squad === 'u1'), { squad: 'u1', delta: 5, reasons: ['fed', 'home'], value: 65 });
  assert.equal(md.starved, false);
});

test('finishDay：飢えた日は全部隊 −15（本拠地の +3 は付く）、starve に shortfall', () => {
  const st = makeState();
  st.lands.ocean.res.food = 5;
  add(st, 'u1', 1, C);
  add(st, 'u2', 1, FAR);
  const ev = finishDay(st, db);
  // 消費 floor(100 / 10) + floor(100 / d)。足りない量は 消費 − 5
  assert.deepEqual(byT(ev, 'starve'), [{ t: 'starve', land: 'ocean', shortfall: 10 + Math.floor(100 / D) - 5 }]);
  assert.equal(st.squads.u1.morale, 48);
  assert.equal(st.squads.u2.morale, 45);
});

test('finishDay：回復・支援の隣は飢え・節約の減りが半分（切り捨て）', () => {
  const st = makeState();
  st.lands.ocean.res.food = 5;
  add(st, 'u1', 1, C);
  add(st, 'u3', 3, 20); // 回復（healer）。u1 の隣
  finishDay(st, db);
  assert.equal(st.squads.u1.morale, 60 - 7 + 3); // −15 → −7
  assert.equal(st.squads.u3.morale, 45); // 自分の減りは半分にしない

  const st2 = makeState();
  st2.lands.ocean.ration = 'save';
  add(st2, 'u1', 1, C);
  add(st2, 'u4', 4, 20); // 支援（support）
  finishDay(st2, db);
  assert.equal(st2.squads.u1.morale, 60 + 2 + 3 - 2); // 節約 −4 → −2
  assert.equal(st2.squads.u4.morale, 60 + 2 - 4);
});

test('finishDay：配給 増量は毎日 +4、指揮は隣の味方 +2・自分 +2', () => {
  const st = makeState();
  st.lands.ocean.ration = 'feast';
  add(st, 'u1', 1, C);
  add(st, 'u2', 2, 20); // 指揮（commander）
  finishDay(st, db);
  assert.equal(st.squads.u1.morale, 60 + 2 + 3 + 4 + 2);
  assert.equal(st.squads.u2.morale, 60 + 2 + 4 + 2);
});

test('finishDay：士気は 0〜100 で切る', () => {
  const st = makeState();
  add(st, 'u1', 1, C, { morale: 98 });
  finishDay(st, db);
  assert.equal(st.squads.u1.morale, 100);
});

// ---------------------------------------------------------------- 逃走（§1）

test('士気 0 の部隊は 1 日の終わりに兵の 8%（切り上げ）が逃げる。逃げた兵は人口に戻らない', () => {
  const st = makeState();
  st.lands.ocean.res.food = 0;
  st.lands.ocean.res.pop = 50;
  add(st, 'u1', 1, FAR, { morale: 10, troops: 101 });
  const ev = finishDay(st, db);
  assert.equal(DESERT_RATE, 0.08);
  assert.deepEqual(byT(ev, 'desert'), [{ t: 'desert', squad: 'u1', amount: 9, left: 92 }]); // ceil(8.08)
  assert.equal(st.squads.u1.troops, 92);
  assert.equal(st.squads.u1.morale, 0);
  assert.equal(st.lands.ocean.res.pop, 50); // 飢えた日は自然増なし・逃げた兵も戻らない

  // 士気が 0 より上に戻る日は逃げない（足りた日 +2）
  const st2 = makeState();
  add(st2, 'u1', 1, FAR, { morale: 0, troops: 101 });
  assert.equal(byT(finishDay(st2, db), 'desert').length, 0);
  assert.equal(st2.squads.u1.morale, 2);

  // 節約で本拠地の外：+2 − 4 で 0 に落ちた夜から逃げる
  const st3 = makeState();
  st3.lands.ocean.ration = 'save';
  add(st3, 'u1', 1, FAR, { morale: 1, troops: 10 });
  assert.deepEqual(byT(finishDay(st3, db), 'desert'), [{ t: 'desert', squad: 'u1', amount: 1, left: 9 }]);
});

// ---------------------------------------------------------------- 兵はただで増えない（§2）

test('本拠地の夜の回復は人口を消費する（足りる分だけ・部隊の並び順）', () => {
  const st = makeState();
  st.lands.ocean.res.pop = 5;
  add(st, 'u1', 1, C, { troops: 50 });
  add(st, 'u2', 1, C, { troops: 50 });
  finishDay(st, db);
  // 人口 5 + 自然増 1 = 6 を u1 が先に使う
  assert.equal(st.squads.u1.troops, 56);
  assert.equal(st.squads.u2.troops, 50);
  assert.equal(st.lands.ocean.res.pop, 0);
  // 人口 0（自然増 1 は付く）→ 1 だけ
  finishDay(st, db);
  assert.equal(st.squads.u1.troops + st.squads.u2.troops, 107);
});

test('人口 0 で自然増も無い日（飢え）は、回復・支援の隣でも兵は増えない', () => {
  const st = makeState();
  st.lands.ocean.res = { pop: 0, food: 0, gum: 0, mat: 0 };
  add(st, 'u1', 1, C, { troops: 50 });
  add(st, 'u3', 3, 20, { troops: 50 });
  finishDay(st, db);
  assert.equal(st.squads.u1.troops, 50);
  assert.equal(st.lands.ocean.res.pop, 0);
});

test('飢えた夜は本拠地の回復なし。回復ヒーローの隣の回復は人口を使って起きる', () => {
  const st = makeState();
  st.lands.ocean.res.food = 0;
  add(st, 'u1', 1, C, { troops: 50 });
  finishDay(st, db);
  assert.equal(st.squads.u1.troops, 50);
  assert.equal(st.lands.ocean.res.pop, 100);

  const st2 = makeState();
  st2.lands.ocean.res.food = 0;
  add(st2, 'u1', 1, C, { troops: 50 });
  add(st2, 'u3', 3, 20, { troops: 50 });
  finishDay(st2, db);
  assert.equal(st2.squads.u1.troops, 70); // 上限 200 × 0.1
  assert.equal(st2.lands.ocean.res.pop, 80);
});

test('finishDay の順番：飢え → 士気 → 逃走 → 回復（逃げたあとに回復する）', () => {
  const st = makeState();
  st.lands.ocean.res.food = 0;
  add(st, 'u1', 1, C, { troops: 100, morale: 3 });
  add(st, 'u3', 3, 20, { troops: 50 });
  const ev = finishDay(st, db);
  // 士気 3 − 7（回復の隣で半分）+ 3 = −1 → 0 → 逃走 ceil(8) = 8 → 92 → 回復 +20 → 112
  assert.equal(st.squads.u1.morale, 0);
  assert.equal(st.squads.u1.troops, 112);
  const order = ev.map((e) => e.t).filter((t) => ['yield', 'starve', 'morale_day', 'desert'].includes(t));
  assert.deepEqual(order, ['yield', 'starve', 'morale_day', 'desert']);
});

test('applyNight は planNight の計画どおりに反映する', () => {
  const st = makeState();
  add(st, 'u1', 1, C, { troops: 100, morale: 0 });
  st.lands.ocean.ration = 'save';
  const plan0 = planNight(st, db, 'ocean', true, 40);
  applyNight(st, db, 'ocean', true);
  const m = plan0.morale[0];
  assert.equal(st.squads.u1.morale, m.value);
  assert.equal(st.squads.u1.troops, 100 - plan0.desert[0].amount + plan0.recover.reduce((a, r) => a + r.amount, 0));
});

// ---------------------------------------------------------------- 配給（§3）

test('配給：兵の食料の消費 × 0.75 / × 1 / × 1.25。人口の消費は変わらない', () => {
  const st = makeState();
  add(st, 'u1', 1, C, { troops: 50 });
  add(st, 'u2', 1, FAR, { troops: 51 });
  assert.equal(upkeep(st, db, 'ocean').food, 10 + Math.floor(101 / D)); // floor(101 / d)
  assert.deepEqual(setRation(st, 'ocean', 'save'), { ok: true, reason: null });
  assert.equal(upkeep(st, db, 'ocean').food, 10 + Math.floor((101 * 3) / (4 * D))); // floor(101 × 0.75 / d)
  setRation(st, 'ocean', 'feast');
  assert.equal(upkeep(st, db, 'ocean').food, 10 + Math.floor((101 * 5) / (4 * D))); // floor(101 × 1.25 / d)
  // 倍率の向き：節約 < 通常 < 増量
  assert.ok(Math.floor((101 * 3) / (4 * D)) < Math.floor((101 * 5) / (4 * D)));
  assert.deepEqual(setRation(st, 'ocean', 'banquet'), { ok: false, reason: 'ration' });
  assert.equal(st.lands.ocean.ration, 'feast');
});

test('troopFood：部隊ごとの行の合計は必ず total（端数は大きい部隊から）', () => {
  const st = makeState();
  // 端数（d で割った余り）が 1, d − 3, 2 になる兵。余りの合計がちょうど d なので、合計は切り捨ての和 + 1
  add(st, 'u1', 1, C, { troops: D + 1 });
  add(st, 'u2', 1, C, { troops: D + (D - 3) });
  add(st, 'u3', 1, C, { troops: 2 * D + 2 });
  for (const r of ['save', 'normal', 'feast']) {
    const tf = troopFood(st, db, 'ocean', { ration: r });
    assert.equal(tf.rows.reduce((a, x) => a + x.value, 0), tf.total, r);
  }
  // normal：合計 5。切り捨てで 1, 1, 2、残りの 1 は端数のいちばん大きい u2 へ
  assert.equal(troopFood(st, db, 'ocean').total, 5);
  assert.deepEqual(troopFood(st, db, 'ocean').rows.map((x) => x.value), [1, 2, 2]);
});

test('previewRation：その配給での食料の差し引きと、毎日の士気', () => {
  const st = makeState();
  add(st, 'u1', 1, C, { troops: 50 });
  // 収入 0、支出 人口 10 + 兵 floor(50 × 倍率 / d)
  const normal = -(10 + Math.floor(50 / D));
  const save = -(10 + Math.floor((50 * 3) / (4 * D)));
  const feast = -(10 + Math.floor((50 * 5) / (4 * D)));
  assert.deepEqual(previewRation(st, db, 'ocean', 'normal'), { perDay: { food: normal }, delta: { food: 0 }, moralePerDay: 0 });
  assert.deepEqual(previewRation(st, db, 'ocean', 'save'), { perDay: { food: save }, delta: { food: save - normal }, moralePerDay: -4 });
  assert.deepEqual(previewRation(st, db, 'ocean', 'feast'), { perDay: { food: feast }, delta: { food: feast - normal }, moralePerDay: 4 });
  assert.ok(save > normal && feast < normal, '節約は消費が減り、増量は増える');
  assert.equal(st.lands.ocean.ration, 'normal'); // 見込みは state を変えない
});

// ---------------------------------------------------------------- 恩賞（§4）

test('恩賞：GUM 10 + ceil(兵 ÷ 20) を払い、士気 +20', () => {
  assert.ok(DOMESTIC_KINDS.includes('reward'));
  assert.deepEqual(DOMESTIC_KINDS, ['conscript', 'farm', 'trade', 'craft', 'reward']);
  const st = makeState();
  const u = add(st, 'u1', 1, C, { troops: 50, morale: 30 });
  assert.equal(rewardCost(u), 13);
  const ev = domestic(st, db, u, 'reward');
  assert.equal(st.lands.ocean.res.gum, 107);
  assert.equal(u.morale, 50);
  assert.deepEqual(ev, { t: 'domestic', squad: 'u1', kind: 'reward', amount: 20, cost: 13, morale: { t: 'morale', squad: 'u1', delta: 20, reason: 'reward', value: 50 } });
  // GUM が足りなければ何もしない
  st.lands.ocean.res.gum = 12;
  const ev2 = domestic(st, db, u, 'reward');
  assert.equal(ev2.amount, 0);
  assert.equal(st.lands.ocean.res.gum, 12);
  assert.equal(u.morale, 50);
});

test('恩賞：orders.validate は GUM 不足を "gum" で断る（積んだ恩賞の分も引く）', () => {
  const st = makeState();
  add(st, 'u1', 1, C, { troops: 50 });
  st.lands.ocean.res.gum = 26;
  assert.deepEqual(queue(st, db, 'u1', { type: 'domestic', kind: 'reward' }), { ok: true, reason: null });
  assert.deepEqual(queue(st, db, 'u1', { type: 'domestic', kind: 'reward' }), { ok: true, reason: null });
  assert.deepEqual(validate(st, db, st.squads.u1, { type: 'domestic', kind: 'reward' }), { ok: false, reason: 'gum' });
  // 本拠地にいなければ home が先
  st.squads.u1.orders = [];
  st.squads.u1.tile = FAR;
  assert.equal(validate(st, db, st.squads.u1, { type: 'domestic', kind: 'reward' }).reason, 'home');
});

test('恩賞・休息は実行フェーズで morale イベントも出す。実行のときに GUM が足りなければ blocked(gum)', () => {
  const st = newGame({ seed: 4, playerLand: 'ocean', db: realDb });
  const mine = Object.values(st.squads).filter((s) => s.land === 'ocean');
  const [a, b, c] = mine;
  a.morale = 30;
  assert.ok(queue(st, realDb, a.id, { type: 'domestic', kind: 'reward' }).ok);
  assert.ok(queue(st, realDb, b.id, { type: 'rest' }).ok);
  assert.ok(queue(st, realDb, c.id, { type: 'domestic', kind: 'reward' }).ok);
  st.lands.ocean.res.gum = rewardCost(a); // 1 回分しか残っていない
  for (const l of Object.values(st.lands)) l.cpu = false; // CPU は動かさない
  const evs = [...execute(st, realDb, makeRng(1))];
  const rewards = evs.filter((e) => e.t === 'domestic' && e.kind === 'reward');
  assert.equal(rewards.length, 1);
  assert.ok(evs.some((e) => e.t === 'morale' && e.reason === 'reward'));
  assert.ok(evs.some((e) => e.t === 'morale' && e.reason === 'rest' && e.squad === b.id));
  assert.ok(evs.some((e) => e.t === 'blocked' && e.reason === 'gum'));
});

// ---------------------------------------------------------------- 見込み（§6.3）

test('previewDomestic：農作・徴兵・恩賞の見込みと perDay・repeat、積んだあとの続き', () => {
  const st = makeState();
  const u = add(st, 'u1', 1, C, { troops: 50 });
  let p = previewDomestic(st, db, u, 'farm');
  assert.deepEqual(p, { ok: true, reason: null, delta: { food: 35, gum: 0, mat: 0, pop: 0, troops: 0, morale: 0 }, perDay: { food: 35 }, repeat: 5 });
  queue(st, db, 'u1', { type: 'domestic', kind: 'farm' });
  p = previewDomestic(st, db, u, 'farm');
  assert.equal(p.delta.food, 15); // 150 + 35 = 185 → 上限 200 まで
  assert.equal(p.repeat, 4);
  st.squads.u1.orders = [];
  st.squads.u1.ap = 11;

  p = previewDomestic(st, db, u, 'conscript');
  assert.deepEqual(p.delta, { food: 0, gum: 0, mat: 0, pop: -30, troops: 30, morale: 0 });
  // 兵の消費が増える分（floor(50 / d) − floor(80 / d)）と、人口の消費が減る分（floor(100 / 10) − floor(70 / 10)）を合わせる
  assert.deepEqual(p.perDay, { food: Math.floor(50 / D) - Math.floor(80 / D) + (Math.floor(100 / 10) - Math.floor(70 / 10)) });
  assert.ok(Math.floor(80 / D) > Math.floor(50 / D), '徴兵は兵の食料を増やす');
  // 積んで実行すると、翌日の食料は 今の食料 + breakdown の net + perDay（UI の「このあと」）になる
  const expect = st.lands.ocean.res.food + breakdown(st, db, 'ocean').food.net + p.perDay.food;
  const c2 = structuredClone(st);
  queue(c2, db, 'u1', { type: 'domestic', kind: 'conscript' });
  [...execute(c2, db, makeRng(1))];
  assert.equal(c2.lands.ocean.res.food, expect);

  p = previewDomestic(st, db, u, 'reward');
  assert.deepEqual(p.delta, { food: 0, gum: -13, mat: 0, pop: 0, troops: 0, morale: 20 });
  st.lands.ocean.res.gum = 5;
  p = previewDomestic(st, db, u, 'reward');
  assert.equal(p.ok, false);
  assert.equal(p.reason, 'gum');
  assert.equal(p.delta.morale, 20); // 払えたときの値は見せる

  u.tile = FAR;
  assert.equal(previewDomestic(st, db, u, 'farm').reason, 'home');
  u.tile = C;
  u.ap = 1;
  assert.equal(previewDomestic(st, db, u, 'farm').reason, 'ap');
});

test('徴兵：人口から 1 人も移せない（人口 0〜3）と validate は "pop" で断り、previewDomestic は ok:false / pop', () => {
  const st = makeState();
  const u = add(st, 'u1', 1, C, { troops: 50 });
  for (const pop of [0, 3]) {
    st.lands.ocean.res.pop = pop;
    assert.deepEqual(validate(st, db, u, { type: 'domestic', kind: 'conscript' }), { ok: false, reason: 'pop' }, `人口 ${pop}`);
    assert.equal(queue(st, db, 'u1', { type: 'domestic', kind: 'conscript' }).ok, false);
    const p = previewDomestic(st, db, u, 'conscript');
    assert.equal(p.ok, false);
    assert.equal(p.reason, 'pop');
    assert.equal(p.delta.troops, 0);
    assert.equal(p.perDay.food, 0);
    assert.equal(p.repeat, 0);
  }
  // 人口 4 なら 1 人移せる
  st.lands.ocean.res.pop = 4;
  assert.equal(validate(st, db, u, { type: 'domestic', kind: 'conscript' }).ok, true);
  assert.equal(previewDomestic(st, db, u, 'conscript').delta.troops, 1);
  // 積んである徴兵・休息が人口を使い切ったあとも "pop"
  st.lands.ocean.res.pop = 10;
  assert.equal(queue(st, db, 'u1', { type: 'domestic', kind: 'conscript' }).ok, true); // 10 → 7
  assert.equal(queue(st, db, 'u1', { type: 'domestic', kind: 'conscript' }).ok, true); // 7 → 5
  assert.equal(queue(st, db, 'u1', { type: 'domestic', kind: 'conscript' }).ok, true); // 5 → 4
  assert.equal(queue(st, db, 'u1', { type: 'domestic', kind: 'conscript' }).ok, true); // 4 → 3
  assert.equal(validate(st, db, u, { type: 'domestic', kind: 'conscript' }).reason, 'pop');
  assert.equal(previewDomestic(st, db, u, 'conscript').reason, 'pop');
  // AP が足りないときは "ap" が先（恩賞の "gum" と同じ）。本拠地の外は "home" が先
  u.orders = [];
  u.ap = 1;
  st.lands.ocean.res.pop = 0;
  assert.equal(validate(st, db, u, { type: 'domestic', kind: 'conscript' }).reason, 'ap');
  assert.equal(previewDomestic(st, db, u, 'conscript').reason, 'ap');
  u.ap = 11;
  u.tile = FAR;
  assert.equal(validate(st, db, u, { type: 'domestic', kind: 'conscript' }).reason, 'home');
  assert.equal(previewDomestic(st, db, u, 'conscript').reason, 'home');
});

test('previewDomestic：この 1 回で何も増えない回は ok:false / cap（農作・工作は上限、徴兵は兵の上限、恩賞は士気 100）', () => {
  const st = makeState();
  const u = add(st, 'u1', 1, C, { troops: 50 });
  // 農作：150 + 35 → 185、+15 → 200、その次は 0 で cap
  assert.equal(queue(st, db, 'u1', { type: 'domestic', kind: 'farm' }).ok, true);
  let p = previewDomestic(st, db, u, 'farm');
  assert.equal(p.ok, true);
  assert.equal(p.delta.food, 15, '上限まで少しでも増えるうちは ok');
  assert.equal(queue(st, db, 'u1', { type: 'domestic', kind: 'farm' }).ok, true);
  p = previewDomestic(st, db, u, 'farm');
  assert.deepEqual([p.ok, p.reason, p.delta.food, p.perDay.food, p.repeat], [false, 'cap', 0, 0, 0]);
  u.orders = [];
  u.ap = 11;
  st.lands.ocean.res.food = 200;
  assert.equal(previewDomestic(st, db, u, 'farm').reason, 'cap');
  // 工作：素材が上限
  st.lands.ocean.res.mat = 100;
  assert.equal(previewDomestic(st, db, u, 'craft').reason, 'cap');
  st.lands.ocean.res.mat = 60;
  assert.equal(previewDomestic(st, db, u, 'craft').ok, true);
  // 交易は上限が無い
  assert.equal(previewDomestic(st, db, u, 'trade').ok, true);
  // 徴兵：兵が上限（人口はある）→ cap。validate は断らない
  u.troops = troopCap(db.heroes[1], u, db);
  p = previewDomestic(st, db, u, 'conscript');
  assert.deepEqual([p.ok, p.reason, p.delta.troops], [false, 'cap', 0]);
  assert.equal(validate(st, db, u, { type: 'domestic', kind: 'conscript' }).ok, true);
  // 人口も無いときは pop が先
  st.lands.ocean.res.pop = 0;
  assert.equal(previewDomestic(st, db, u, 'conscript').reason, 'pop');
  // 恩賞：士気 100
  u.troops = 50;
  u.morale = 100;
  p = previewDomestic(st, db, u, 'reward');
  assert.deepEqual([p.ok, p.reason, p.delta.morale], [false, 'cap', 0]);
  u.morale = 90;
  p = previewDomestic(st, db, u, 'reward');
  assert.deepEqual([p.ok, p.reason, p.delta.morale], [true, null, 10]);
});

test('breakdown：行の合計が net、daysLeft、上限を超えた分の行、飢える日は自然増の行なし', () => {
  const st = makeState();
  add(st, 'u1', 1, C, { troops: 50 });
  let b = breakdown(st, db, 'ocean');
  const eat = 10 + Math.floor(50 / D);
  assert.equal(b.food.net, -eat);
  assert.equal(b.food.daysLeft, Math.floor(150 / eat) + 1);
  assert.deepEqual(b.food.expense.map((r) => [r.key, r.value, r.squad]), [['pop', 10, undefined], ['troops', Math.floor(50 / D), 'u1']]);
  assert.equal(b.gum.daysLeft, null);
  assert.equal(b.pop.income[0].key, 'growth');
  // 人口 100 + 1 は上限 100 → 上限の行 1、本拠地の回復 20 は人口から
  assert.deepEqual(b.pop.expense.map((r) => [r.key, r.value]), [['cap', 1], ['recover', 20]]);
  assert.equal(b.pop.net, -20);
  st.lands.ocean.res.food = 10;
  b = breakdown(st, db, 'ocean');
  assert.equal(b.food.daysLeft, 1); // 今夜尽きる
  assert.ok(!b.pop.income.some((r) => r.key === 'growth'));
  assert.ok(!b.pop.expense.some((r) => r.key === 'recover')); // 飢えた夜は本拠地の回復なし
  for (const k of ['food', 'gum', 'mat', 'pop']) {
    const sum = b[k].income.reduce((a, r) => a + r.value, 0) - b[k].expense.reduce((a, r) => a + r.value, 0);
    assert.equal(sum, b[k].net, k);
  }
  const f = forecast(st, db, 'ocean');
  // shortfall：今夜足りない量（在庫 10 + 差し引き −15 → 5 足りない）
  assert.deepEqual(f.food, { net: b.food.net, daysLeft: 1, shortfall: -(10 + b.food.net) });
  assert.equal(f.food.shortfall, 5);
  assert.deepEqual(f.troops, { total: 50, cap: 200 });
  assert.deepEqual(f.morale, { avg: 60, min: 60, shaken: 0, deserting: 0, desertTonight: 0, desert: [] });
  st.lands.ocean.res.food = 150;
  assert.equal(forecast(st, db, 'ocean').food.shortfall, 0, '足りる夜は 0');
});

test('breakdown：複数シード・複数日で、行の合計 = net、指示なしの夜の実際の増減 = net', () => {
  for (const seed of [1, 2, 3]) {
    const st = newGame({ seed, playerLand: 'ocean', db: realDb });
    for (const l of Object.values(st.lands)) l.cpu = true;
    const rng = makeRng(seed * 31 + 7);
    for (let day = 0; day < 10 && !st.ended; day++) {
      for (const l of Object.values(st.lands)) {
        if (l.id === 'enemy' || l.alive === false) continue;
        const b = breakdown(st, realDb, l.id);
        for (const k of ['food', 'gum', 'mat', 'pop']) {
          const sum = b[k].income.reduce((a, r) => a + r.value, 0) - b[k].expense.reduce((a, r) => a + r.value, 0);
          assert.equal(sum, b[k].net, `seed ${seed} day ${st.day} ${l.id} ${k}`);
          assert.ok(b[k].income.every((r) => r.value > 0) && b[k].expense.every((r) => r.value > 0));
        }
        const f = forecast(st, realDb, l.id);
        assert.equal(f.food.net, b.food.net);
      }
      // 指示のない夜（finishDay だけ）を写しで回すと、実際の増減が net に一致する
      const copy = structuredClone(st);
      const pred = {};
      for (const l of Object.values(copy.lands)) if (l.id !== 'enemy' && l.alive !== false) pred[l.id] = { b: breakdown(copy, realDb, l.id), res: { ...l.res } };
      finishDay(copy, realDb);
      for (const id of Object.keys(pred)) {
        const { b, res } = pred[id];
        const now = copy.lands[id].res;
        assert.equal(now.food, Math.max(0, res.food + b.food.net), `seed ${seed} day ${st.day} ${id} food`);
        assert.equal(now.gum, res.gum + b.gum.net, `${id} gum`);
        assert.equal(now.mat, res.mat + b.mat.net, `${id} mat`);
        assert.equal(now.pop, res.pop + b.pop.net, `seed ${seed} day ${st.day} ${id} pop`);
      }
      planCpu(st, realDb, rng);
      [...execute(st, realDb, rng)];
      if (!st.ended) beginTurn(st, realDb);
    }
  }
});

// ---------------------------------------------------------------- 見込みと実際の突き合わせ（検証班）

test('UI の「このあと」（breakdown の net + 積んだ内政の perDay / delta）が、5 日続けて実際の翌日の食料・GUM に一致する', () => {
  const st = makeState();
  add(st, 'u1', 1, C, { troops: 40 });
  add(st, 'u2', 2, C, { troops: 30 });
  add(st, 'u3', 3, 20, { troops: 60 }); // 回復（healer）。本拠地の隣
  const rations = ['normal', 'save', 'feast', 'normal', 'save'];
  const plans = [
    { u1: ['farm'], u2: ['conscript'] },
    { u1: ['farm', 'farm'], u2: ['conscript', 'reward'] },
    { u1: ['trade'], u2: ['reward', 'conscript'] },
    { u1: [], u2: ['conscript', 'conscript'] },
    { u1: ['farm', 'farm', 'farm', 'farm', 'farm'], u2: ['craft'] },
  ];
  let starvedDays = 0;
  for (let day = 0; day < 5; day++) {
    setRation(st, 'ocean', rations[day]);
    const land = st.lands.ocean;
    if (day === 3) land.res.food = 5; // 内政で食料を足さない日に、尽きる夜を通す
    // 本拠地の夜の回復が人口を使い切るので、徴兵する日は人口を戻しておく（人口 0〜3 の徴兵は validate が断る。別のテスト）
    if (land.res.pop < 60) land.res.pop = 60;
    const b = breakdown(st, db, 'ocean');
    let food = b.food.net;
    let gum = b.gum.net;
    for (const [id, kinds] of Object.entries(plans[day])) {
      for (const kind of kinds) {
        const p = previewDomestic(st, db, st.squads[id], kind);
        assert.equal(p.ok, true, `day ${day} ${id} ${kind}: ${p.reason}`);
        assert.equal(queue(st, db, id, { type: 'domestic', kind }).ok, true);
        food += p.perDay.food;
        gum += p.delta.gum;
      }
    }
    const cap = b.food.cap;
    const expectFood = Math.max(0, Math.min(cap, land.res.food + food));
    const expectGum = land.res.gum + gum;
    const evs = [...execute(st, db, makeRng(day + 1))];
    if (byT(evs, 'starve').length) starvedDays++;
    assert.equal(byT(evs, 'blocked').length, 0, `day ${day}: 指示が捨てられていない`);
    assert.equal(land.res.food, expectFood, `day ${day} 食料`);
    assert.equal(land.res.gum, expectGum, `day ${day} GUM`);
    beginTurn(st, db);
  }
  assert.ok(starvedDays >= 1, '食料が尽きる日も確かめている');
});

test('forecast の desertTonight と breakdown の食料・人口が、士気の低い部隊・飢える夜でも、5 日続けて実際の夜に一致する', () => {
  let deserted = 0;
  let starved = 0;
  let notTonight = 0;
  for (const seed of [1, 2, 3]) {
    const st = newGame({ seed, playerLand: 'ocean', db: realDb });
    for (const l of Object.values(st.lands)) l.cpu = true;
    const rng = makeRng(seed * 17 + 3);
    const r2 = makeRng(seed * 59 + 11);
    for (let day = 0; day < 5 && !st.ended; day++) {
      const copy = structuredClone(st);
      for (const s of Object.values(copy.squads)) s.morale = [0, 0, 1, 2, 4, 15, 60][Math.floor(r2() * 7)];
      for (const l of Object.values(copy.lands)) {
        if (l.id === 'enemy') continue;
        if (r2() < 0.4) l.res.food = Math.floor(r2() * 20);
        setRation(copy, l.id, ['save', 'normal', 'feast'][Math.floor(r2() * 3)]);
      }
      const pred = {};
      for (const l of Object.values(copy.lands)) {
        if (l.id === 'enemy' || l.alive === false) continue;
        pred[l.id] = { f: forecast(copy, realDb, l.id), b: breakdown(copy, realDb, l.id), res: { ...l.res } };
        notTonight += pred[l.id].f.morale.deserting > 0 && pred[l.id].f.morale.desertTonight === 0 ? 1 : 0;
      }
      const evs = finishDay(copy, realDb);
      const got = {};
      const gotBySquad = {};
      for (const e of byT(evs, 'desert')) {
        const land = copy.squads[e.squad].land;
        got[land] = (got[land] || 0) + e.amount;
        (gotBySquad[land] = gotBySquad[land] || []).push({ squad: e.squad, amount: e.amount });
      }
      starved += byT(evs, 'starve').length;
      for (const [id, { f, b, res }] of Object.entries(pred)) {
        const where = `seed ${seed} day ${st.day} ${id}`;
        assert.equal(got[id] || 0, f.morale.desertTonight, `${where} 逃げた兵`);
        // 部隊ごとの内訳：実際に逃げた部隊と人数がそのまま並ぶ。合計は desertTonight
        assert.deepEqual(f.morale.desert, gotBySquad[id] || [], `${where} 部隊ごとの逃げた兵`);
        assert.equal(f.morale.desert.reduce((x, d) => x + d.amount, 0), f.morale.desertTonight);
        deserted += got[id] || 0;
        const now = copy.lands[id].res;
        assert.equal(now.food, Math.max(0, res.food + b.food.net), `${where} 食料`);
        assert.equal(now.pop, res.pop + b.pop.net, `${where} 人口`);
      }
      planCpu(st, realDb, rng);
      [...execute(st, realDb, rng)];
      if (!st.ended) beginTurn(st, realDb);
    }
  }
  assert.ok(deserted > 0 && starved > 0 && notTonight > 0, `逃走・飢え・「士気 0 でも今夜は逃げない」を通している（${deserted} / ${starved} / ${notTonight}）`);
});

test('predict：実際のゲームの盤面（士気をばらした部隊・砦・本拠地）でも、min ≤ resolve の結果 ≤ max、陥落の none / sure も外れない', () => {
  const st = newGame({ seed: 3, playerLand: 'ocean', db: realDb });
  for (const l of Object.values(st.lands)) l.cpu = true;
  const rng = makeRng(3);
  const kinds = new Set();
  let checks = 0;
  for (let day = 0; day < 10 && !st.ended; day++) {
    const r2 = makeRng(day * 1000 + 3);
    for (const a of Object.values(st.squads)) {
      if (a.status === 'routed' || a.troops <= 0) continue;
      a.morale = Math.floor(r2() * 101);
    }
    for (const a of Object.values(st.squads)) {
      if (a.status === 'routed' || a.troops <= 0 || r2() < 0.5) continue;
      for (const t of within(a.tile, 3, st.map.w, st.map.h)) {
        const tgt = targetAt(st, a.land, t);
        if (!tgt || !inRange(st, realDb, a, t)) continue;
        const p = predict(st, realDb, a, tgt);
        kinds.add(p.target);
        for (let i = 0; i < 3; i++) {
          const c = structuredClone(st);
          const ca = c.squads[a.id];
          const ct = tgt.home ? { home: tgt.home } : tgt.rank ? c.forts[tgt.id] : c.squads[tgt.id];
          const ev = resolve(c, realDb, makeRng(i * 7 + day * 13 + 1), ca, ct);
          checks++;
          const where = `day ${st.day} ${a.id} → ${p.target} ${p.defenderId} #${i}`;
          const at = Math.max(0, ca.troops);
          assert.ok(p.attacker.min <= at && at <= p.attacker.max, `${where} 攻め手 ${at}`);
          let dt = 0;
          if (p.defenderId && c.squads[p.defenderId]) dt = Math.max(0, c.squads[p.defenderId].troops);
          else if (p.target === 'fort') dt = ev.result === 'fort_fallen' ? 0 : c.forts[ct.id].troops;
          assert.ok(p.defender.min <= dt && dt <= p.defender.max, `${where} 守り手 ${dt}`);
          const fell = /fallen/.test(ev.result);
          assert.ok(!(p.fall === 'none' && fell) && !(p.fall === 'sure' && !fell), `${where} 陥落 ${p.fall} / ${ev.result}`);
        }
      }
    }
    planCpu(st, realDb, rng);
    [...execute(st, realDb, rng)];
    if (!st.ended) beginTurn(st, realDb);
  }
  assert.ok(checks >= 100 && kinds.has('squad') && kinds.has('fort'), `${checks} 回・${[...kinds]}`);
});

test('古いセーブ（morale / ration 無し・範囲の外の士気）を読んで、そのまま 3 日遊べる', () => {
  const st = newGame({ seed: 4, playerLand: 'ocean', db: realDb });
  const old = JSON.parse(serialize(st));
  for (const s of Object.values(old.squads)) delete s.morale;
  for (const l of Object.values(old.lands)) delete l.ration;
  const ids = Object.keys(old.squads);
  old.squads[ids[0]].morale = 150;
  old.squads[ids[1]].morale = -7;
  old.squads[ids[2]].morale = 33.6;
  const back = deserialize(JSON.stringify(old));
  assert.deepEqual([back.squads[ids[0]].morale, back.squads[ids[1]].morale, back.squads[ids[2]].morale], [100, 0, 34]);
  for (const l of Object.values(back.lands)) l.cpu = true;
  const rng = makeRng(4);
  for (let d = 0; d < 3; d++) {
    planCpu(back, realDb, rng);
    [...execute(back, realDb, rng)];
    beginTurn(back, realDb);
  }
  for (const s of Object.values(back.squads)) assert.ok(Number.isInteger(s.morale) && s.morale >= 0 && s.morale <= 100, `${s.id} ${s.morale}`);
  for (const l of Object.values(back.lands)) assert.ok(['save', 'normal', 'feast'].includes(l.ration));
});

test('でたらめな指示と極端な資源（人口 0・GUM わずか・食料 0・士気 0 / 100）でも、人口・兵・資源は負にならず、士気は 0〜100 の整数', () => {
  for (const seed of [2, 6]) {
    let st = newGame({ seed, playerLand: 'ocean', db: realDb });
    const rng = makeRng(seed * 101);
    const r2 = makeRng(seed * 977 + 5);
    const check = (where) => {
      for (const l of Object.values(st.lands)) {
        for (const k of ['pop', 'food', 'gum', 'mat']) assert.ok(Number.isInteger(l.res[k]) && l.res[k] >= 0, `${where} ${l.id} ${k}=${l.res[k]}`);
      }
      for (const s of Object.values(st.squads)) {
        assert.ok(Number.isInteger(s.troops) && s.troops >= 0, `${where} ${s.id} troops=${s.troops}`);
        assert.ok(Number.isInteger(s.morale) && s.morale >= 0 && s.morale <= 100, `${where} ${s.id} morale=${s.morale}`);
      }
    };
    for (let day = 0; day < 14 && !st.ended; day++) {
      const me = st.lands.ocean;
      if (r2() < 0.3) me.res.pop = 0;
      if (r2() < 0.2) me.res.gum = Math.floor(r2() * 15);
      if (r2() < 0.2) me.res.food = 0;
      setRation(st, 'ocean', ['save', 'normal', 'feast'][Math.floor(r2() * 3)]);
      planCpu(st, realDb, rng);
      for (const s of Object.values(st.squads)) {
        if (s.land !== 'ocean' || s.status === 'routed') continue;
        if (r2() < 0.2) s.morale = r2() < 0.5 ? 0 : 100;
        s.policy = ['ask', 'fight', 'ignore'][Math.floor(r2() * 3)];
        for (let n = 0; n < 6; n++) {
          const x = r2();
          if (x < 0.45) queue(st, realDb, s.id, { type: 'domestic', kind: DOMESTIC_KINDS[Math.floor(r2() * DOMESTIC_KINDS.length)] });
          else if (x < 0.6) queue(st, realDb, s.id, { type: 'rest' });
          else {
            const nb = neighbors(s.tile, st.map.w, st.map.h);
            queue(st, realDb, s.id, { type: 'move', path: [nb[Math.floor(r2() * nb.length)]] });
          }
        }
      }
      for (const e of execute(st, realDb, rng)) check(`seed ${seed} day ${st.day} ${e.t}`);
      if (!st.ended) beginTurn(st, realDb);
      st = deserialize(serialize(st));
    }
  }
});

// ---------------------------------------------------------------- 通知

test('noticesFrom：飢え・逃走・動揺の文', () => {
  const st = newGame({ seed: 5, playerLand: 'ocean', db: realDb });
  const s = Object.values(st.squads).find((x) => x.land === 'ocean');
  const name = realDb.heroes[s.heroId].name;
  const ns = noticesFrom(st, realDb, [
    { t: 'starve', land: 'ocean', shortfall: 12 },
    { t: 'desert', squad: s.id, amount: 23, left: 100 },
    { t: 'morale_day', land: 'ocean', starved: true, changes: [{ squad: s.id, delta: -15, reasons: ['starve'], value: 15 }] },
    { t: 'starve', land: 'ruby', shortfall: 3 },
  ]);
  const texts = ns.map((n) => n.text);
  assert.ok(texts.includes('食料が足りず、全部隊の士気 −15'));
  assert.ok(texts.includes(`ヒーロー ${name} の部隊から 23 人が逃げた`));
  assert.ok(texts.some((t) => t.includes(name) && t.includes('動揺')));
  assert.equal(ns.length, 3); // 他ランドの飢えは出さない
});

test('noticesFrom：自国の部隊が攻められたら、守った側にも battle の通知（相手のランド・受けた兵・与えた兵）', () => {
  // 実際の盤面で、CPU の部隊にプレイヤーの部隊を攻めさせる
  let checked = 0;
  for (const seed of [1, 2, 3, 4, 5]) {
    const st = newGame({ seed, playerLand: 'ocean', db: realDb });
    const mine = Object.values(st.squads).filter((s) => s.land === 'ocean');
    const foe = Object.values(st.squads).find((s) => s.land !== 'ocean' && s.land !== 'enemy');
    const d = mine[0];
    d.policy = 'fight';
    const { w, h } = st.map;
    // 相手を守り手の隣に置く（射程 1 で届く）
    const near = neighbors(d.tile, w, h).find((i) => !Object.values(st.squads).some((s) => s.tile === i) && realDb.terrain[st.map.tiles[i].terrain].passable !== false);
    if (near == null) continue;
    foe.tile = near;
    if (!inRange(st, realDb, foe, d.tile)) continue;
    const before = d.troops;
    const ev = resolve(st, realDb, makeRng(seed), foe, d);
    assert.equal(ev.defender, d.id);
    assert.deepEqual(Object.keys(ev.losses).sort(), ['attacker', 'defender']);
    assert.equal(ev.losses.defender, before - Math.max(0, d.troops), 'losses.defender は守り手の減った兵');
    const ns = noticesFrom(st, realDb, [ev]);
    const n = ns.find((x) => x.kind === 'battle');
    assert.ok(n, `seed ${seed}: 守った側の battle 通知がある`);
    const foeName = realDb.lands.find((l) => l.id === foe.land).nameJa;
    assert.ok(n.text.includes(foeName), n.text);
    assert.ok(n.text.includes(realDb.heroes[d.heroId].name), n.text);
    assert.ok(n.text.includes(`受けた兵\u00a0${ev.losses.defender}`) && n.text.includes(`与えた兵\u00a0${ev.losses.attacker}`), n.text);
    assert.equal(n.tile, ev.at);
    checked++;
  }
  assert.ok(checked >= 3, `盤面で ${checked} 回確かめた`);
  // 自国の砦（守備部隊なし）が攻められたときも出す。他国どうしの戦闘は出さない
  const st = newGame({ seed: 2, playerLand: 'ocean', db: realDb });
  const f = Object.values(st.forts)[0];
  f.owner = 'ocean';
  const foe = Object.values(st.squads).find((s) => s.land !== 'ocean' && s.land !== 'enemy');
  const fake = { t: 'battle', attacker: foe.id, defender: f.id, target: 'fort', at: f.tile, ambush: false, evaded: false, dmg: 9, result: 'fort_damaged', losses: { attacker: 0, defender: 9 }, followups: [] };
  const ns = noticesFrom(st, realDb, [fake]);
  assert.equal(ns.length, 1);
  assert.ok(ns[0].text.includes(f.name) && ns[0].text.includes('守備兵\u00a0−9'), ns[0].text);
  f.owner = 'enemy';
  assert.equal(noticesFrom(st, realDb, [fake]).length, 0);
});

test('通しで遊んで、自国の部隊が攻められて兵が減った夜には、必ずその部隊の battle 通知がある', () => {
  let hits = 0;
  for (const seed of [1, 2, 3, 4]) {
    const st = newGame({ seed, playerLand: 'ocean', db: realDb });
    for (const l of Object.values(st.lands)) l.cpu = true;
    const rng = makeRng(seed * 13 + 5);
    for (let day = 0; day < 14 && !st.ended; day++) {
      planCpu(st, realDb, rng);
      const evs = [...execute(st, realDb, rng)];
      const top = evs.filter((e) => e.t === 'battle');
      for (const e of top) {
        const d = st.squads[e.defender];
        if (!d || d.land !== 'ocean' || !(e.losses && e.losses.defender > 0)) continue;
        const ns = noticesFrom(st, realDb, [e]);
        assert.ok(ns.some((n) => n.kind === 'battle' && n.text.includes(`受けた兵\u00a0${e.losses.defender}`)), `seed ${seed} day ${st.day}`);
        hits++;
      }
      if (!st.ended) beginTurn(st, realDb);
    }
  }
  assert.ok(hits > 0, `攻められた場面を通している（${hits}）`);
});

// ---------------------------------------------------------------- CPU（ai.js）

function cpuLand(st) {
  return Object.values(st.lands).find((l) => l.cpu && l.id !== 'enemy');
}

test('ai：食料が 3 日以内に尽きる見込みなら配給「節約」', () => {
  const st = newGame({ seed: 6, playerLand: 'ocean', db: realDb });
  const land = cpuLand(st);
  land.res.food = 5;
  plan(st, realDb, makeRng(1), land.id);
  assert.equal(land.ration, 'save');
});

test('ai：食料に余裕があり士気の平均が 40 未満なら「増量」、士気の低い部隊に恩賞', () => {
  const st = newGame({ seed: 6, playerLand: 'ocean', db: realDb });
  const land = cpuLand(st);
  land.res.food = 200;
  land.res.gum = 300;
  const mine = Object.values(st.squads).filter((s) => s.land === land.id);
  for (const s of mine) {
    s.morale = 30;
    s.troops = 10; // 消費を小さくして余裕を作る
  }
  plan(st, realDb, makeRng(1), land.id);
  assert.equal(land.ration, 'feast');
  assert.ok(mine.some((s) => s.orders.some((o) => o.type === 'domestic' && o.kind === 'reward')));
  // ふつうは通常に戻る
  for (const s of mine) {
    s.morale = 70;
    s.orders = [];
  }
  beginTurn(st, realDb);
  plan(st, realDb, makeRng(2), land.id);
  assert.equal(land.ration, 'normal');
});

test('ai：士気 0 の部隊は本拠地へ戻して休息（本拠地にいれば休息を積む）', () => {
  const st = newGame({ seed: 7, playerLand: 'ocean', db: realDb });
  const land = cpuLand(st);
  const s = Object.values(st.squads).find((x) => x.land === land.id);
  s.morale = 0;
  plan(st, realDb, makeRng(1), land.id);
  assert.ok(s.orders.some((o) => o.type === 'rest'), JSON.stringify(s.orders));
  assert.ok(!s.orders.some((o) => o.type === 'move'));
});

test('ai：兵が上限・食料 0・人口 0・士気 5 から始めた CPU のランドも、節約と逃走で持ち直し、逃走で兵 0 の部隊を出さない', () => {
  for (const [seed, L] of [[3, 'grape'], [3, 'sage']]) {
    const st = newGame({ seed, playerLand: 'ocean', db: realDb });
    for (const l of Object.values(st.lands)) l.cpu = true;
    for (const s of Object.values(st.squads)) {
      if (s.land !== L) continue;
      s.troops = troopCap(realDb.heroes[s.heroId], s, realDb);
      s.morale = 5;
    }
    st.lands[L].res.food = 0;
    st.lands[L].res.pop = 0;
    const rng = makeRng(seed);
    const zeroed = new Set();
    let deserted = 0;
    let zeroDays = 0;
    while (!st.ended && st.day <= 24) {
      planCpu(st, realDb, rng);
      for (const e of execute(st, realDb, rng)) {
        if (e.t !== 'desert' || st.squads[e.squad].land !== L) continue;
        deserted += e.amount;
        if (e.left === 0) zeroed.add(e.squad);
      }
      const mine = Object.values(st.squads).filter((s) => s.land === L && s.status !== 'routed');
      if (mine.length && mine.every((s) => s.morale === 0)) zeroDays++;
      if (!st.ended) beginTurn(st, realDb);
    }
    const mine = Object.values(st.squads).filter((s) => s.land === L && s.status !== 'routed');
    const avg = mine.reduce((a, s) => a + s.morale, 0) / mine.length;
    assert.equal(zeroed.size, 0, `seed ${seed} ${L}`);
    assert.ok(deserted > 0, `${L}：逃走を通している`);
    assert.ok(st.lands[L].alive !== false && mine.every((s) => s.troops > 0), `${L}：残っている`);
    assert.ok(avg >= 10, `${L}：士気が持ち直す（平均 ${avg}、全部隊 0 の日 ${zeroDays}）`);
  }
});

test('ai：全ランド CPU で回しても、士気・配給・恩賞が動き、state の形を保つ', () => {
  const st = newGame({ seed: 8, playerLand: 'ocean', db: realDb });
  for (const l of Object.values(st.lands)) l.cpu = true;
  const rng = makeRng(99);
  const seen = { save: 0, reward: 0, morale: 0 };
  for (let d = 0; d < 12 && !st.ended; d++) {
    planCpu(st, realDb, rng);
    for (const l of Object.values(st.lands)) if (l.ration === 'save') seen.save++;
    for (const e of execute(st, realDb, rng)) {
      if (e.t === 'domestic' && e.kind === 'reward') seen.reward++;
      if (e.t === 'morale' || e.t === 'morale_day') seen.morale++;
    }
    if (!st.ended) beginTurn(st, realDb);
    for (const s of Object.values(st.squads)) {
      assert.ok(Number.isInteger(s.morale) && s.morale >= 0 && s.morale <= 100);
      assert.ok(s.troops >= 0);
    }
    for (const l of Object.values(st.lands)) assert.ok(l.res.pop >= 0, `${l.id} pop ${l.res.pop}`);
  }
  assert.ok(seen.morale > 0);
  assert.ok(seen.save + seen.reward > 0);
});
