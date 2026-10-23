// battle 班のテスト：battle.js。node --test tests/battle.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { idx } from "../js/engine/hex.js";
import { power, fortPower, isAmbush, resolve, inRange, FORT_LEAD } from "../js/engine/battle.js";

const extList = JSON.parse(fs.readFileSync(new URL("../data/extensions.json", import.meta.url), "utf8"));
const realHeroes = JSON.parse(fs.readFileSync(new URL("../data/heroes.json", import.meta.url), "utf8"));

/** 手作りのヒーロー（パラメーターを固定してテストの数字を追えるように） */
function hero(id, sub, main, params, skillKind = "damage") {
  return {
    id, name: `H${id}`, image: `Image/Heroes/${id}.png`, rarity: 1,
    params: { act: 6, lead: 50, str: 10, int: 0, gov: 10, pol: 10, ...params },
    cls: { main, sub }, skill: { name: `S${id}`, kind: skillKind, text: "" }, tone: "plain",
  };
}

const testHeroes = [
  hero(1, "gunner", "mid", {}),
  hero(2, "gunner", "mid", {}),
  hero(3, "commander", "front", {}, "buff"),
  hero(4, "guard", "front", {}),
  hero(5, "gunner", "mid", { int: 100 }, "damage"),
  hero(6, "caster", "back", { int: 100, str: 10 }, "damage"),
  hero(7, "gunner", "mid", { int: 100 }, "heal"),
  hero(8, "gunner", "mid", { int: 100 }, "buff"),
  hero(9, "gunner", "mid", { int: 100 }, "debuff"),
  hero(10, "scout", "front", {}),
  hero(11, "sniper", "back", {}),
];
const heroList = realHeroes.concat(testHeroes);
const db = {
  heroes: Object.fromEntries(heroList.map((h) => [h.id, h])),
  heroList,
  extensions: Object.fromEntries(extList.map((e) => [e.id, e])),
};

const W = 20;
const H = 12;
const T = (c, r) => idx(c, r, W);

function land(id, home, cpu = true) {
  return {
    id, cpu, alive: true, home, res: { pop: 100, food: 150, gum: 120, mat: 60 },
    explored: [], souls: [], extensions: [], fortPoints: 0,
    points: { week1: 0, week2: 0, week3: 0, week4: 0 },
  };
}

function makeState() {
  const tiles = [];
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    tiles.push({ c, r, terrain: "grass", owner: null, fort: null, facility: null });
  }
  return {
    version: 1, seed: 7, day: 2, phase: "execute", playerLand: "ocean",
    map: { w: W, h: H, tiles },
    lands: { ocean: land("ocean", T(1, 1), false), ruby: land("ruby", T(15, 9)), lime: land("lime", T(10, 1)) },
    squads: {}, forts: {}, builds: {}, nextId: 100,
    log: [], notices: [], pending: [], ended: null,
  };
}

function addSquad(state, id, heroId, landId, tile, extra = {}) {
  const s = {
    id, heroId, land: landId, tile, troops: 100, ap: 6, orders: [],
    policy: "ask", status: "ok", equip: null, ambushed: false, ...extra,
  };
  state.squads[id] = s;
  return s;
}

function addFort(state, id, rank, tile, extra = {}) {
  const base = { rare: [60, 40], epic: [120, 80], legendary: [250, 160] }[rank];
  const f = {
    id, rank, tile, owner: "enemy", troops: base[0], durability: base[1], maxDurability: base[1],
    enemyId: 310, name: `${rank}砦`, stance: "defend", ...extra,
  };
  state.forts[id] = f;
  state.map.tiles[tile].fort = id;
  state.map.tiles[tile].owner = f.owner;
  return f;
}

/** 決まった値を順に返す rng（尽きたら最後の値） */
function seq(...vals) {
  let i = 0;
  return () => vals[Math.min(i++, vals.length - 1)];
}
const NEVER = () => 0.999; // 回避もスキルも起きない
const ALWAYS = () => 0; // 回避もスキルも起きる

// ---------- power / fortPower ----------

test("power: lead × (1 + 兵/100) × 係数。山で def ×1.2、隣の commander で ×1.1", () => {
  const st = makeState();
  const a = addSquad(st, "a", 1, "ocean", T(5, 5));
  assert.deepEqual(power(st, db, a), { atk: 100, def: 100 });

  const g = addSquad(st, "g", 4, "ruby", T(12, 5), { troops: 50 });
  const pg = power(st, db, g);
  assert.equal(pg.atk, 75);
  assert.ok(Math.abs(pg.def - 97.5) < 1e-9);

  st.map.tiles[T(5, 5)].terrain = "mountain";
  const pm = power(st, db, a);
  assert.equal(pm.atk, 100);
  assert.ok(Math.abs(pm.def - 120) < 1e-9);
  st.map.tiles[T(5, 5)].terrain = "grass";

  addSquad(st, "c", 3, "ocean", T(6, 5));
  const pc = power(st, db, a);
  assert.ok(Math.abs(pc.atk - 110) < 1e-9 && Math.abs(pc.def - 110) < 1e-9);
  // 他ランドの commander は効かない
  assert.deepEqual(power(st, db, g), pg);
});

test("fortPower: rank の lead 相当", () => {
  const st = makeState();
  const f = addFort(st, "f1", "rare", T(8, 8));
  assert.deepEqual(fortPower(st, db, f), { atk: 20 * 1.6, def: 40 });
  f.durability = 20;
  assert.equal(fortPower(st, db, f).def, 30);
  assert.equal(FORT_LEAD.legendary, 60);
});

// ---------- isAmbush / inRange ----------

test("isAmbush: 防御側ランドの全部隊の視界に攻撃側がいなければ奇襲", () => {
  const st = makeState();
  const a = addSquad(st, "a", 1, "ocean", T(5, 5));
  const d = addSquad(st, "d", 2, "ruby", T(8, 5));
  assert.equal(isAmbush(st, db, a, d), true); // 距離 3 > 視界 2
  d.tile = T(7, 5);
  assert.equal(isAmbush(st, db, a, d), false);
  d.tile = T(8, 5);
  addSquad(st, "d2", 11, "ruby", T(4, 6)); // 同ランドの別部隊が見ている
  assert.equal(isAmbush(st, db, a, d), false);

  const f = addFort(st, "f1", "rare", T(5, 8));
  assert.equal(isAmbush(st, db, a, f), true); // 距離 3 > 砦の視界 2
  a.tile = T(5, 7);
  assert.equal(isAmbush(st, db, a, f), false);
  a.tile = T(12, 9); // ruby の本拠地 (15,9) から 3
  delete st.squads.d2;
  assert.equal(isAmbush(st, db, a, { home: "ruby" }), false);
  a.tile = T(11, 9);
  assert.equal(isAmbush(st, db, a, { home: "ruby" }), true);
});

test("inRange: distance ≤ rangeOf", () => {
  const st = makeState();
  const a = addSquad(st, "a", 1, "ocean", T(5, 5)); // gunner 射程 2
  assert.equal(inRange(st, db, a, T(7, 5)), true);
  assert.equal(inRange(st, db, a, T(8, 5)), false);
  const s = addSquad(st, "s", 11, "ocean", T(5, 5)); // sniper 射程 3
  assert.equal(inRange(st, db, s, T(8, 5)), true);
  // 東西ループ
  const e = addSquad(st, "e", 1, "ocean", T(0, 5));
  assert.equal(inRange(st, db, e, T(W - 2, 5)), true);
});

// ---------- resolve: 命中・回避・スキル ----------

test("resolve: 命中の式 dmg = max(1, round(atk×0.5 − def×0.25))", () => {
  const st = makeState();
  const a = addSquad(st, "a", 1, "ocean", T(5, 5));
  const d = addSquad(st, "d", 2, "ruby", T(6, 5), { troops: 60 });
  const ev = resolve(st, db, NEVER, a, d);
  // atk 100, def 80 → 50 − 20 = 30
  assert.equal(ev.t, "battle");
  assert.equal(ev.dmg, 30);
  assert.equal(ev.evaded, false);
  assert.equal(ev.ambush, false);
  assert.equal(ev.result, "hit");
  assert.equal(ev.counter, null); // policy ask は反撃しない
  assert.equal(d.troops, 30);
  assert.equal(ev.at, d.tile);
  assert.equal(ev.defender, "d");
});

test("resolve: 回避（知力 %）と、奇襲なら回避なし・ambushed", () => {
  const st = makeState();
  const a = addSquad(st, "a", 1, "ocean", T(5, 5));
  const d = addSquad(st, "d", 5, "ruby", T(6, 5)); // int 100 で必ず回避
  let ev = resolve(st, db, seq(0.5, 0.999), a, d);
  assert.equal(ev.evaded, true);
  assert.equal(ev.dmg, 0);
  assert.equal(d.troops, 100);
  assert.equal(d.ambushed, false);

  // 視界の外（距離 3）から：奇襲。rng が 0 でも回避しない
  const s = addSquad(st, "s", 11, "ocean", T(9, 5)); // sniper 射程 3、int 0（スキルなし）
  ev = resolve(st, db, ALWAYS, s, d);
  assert.equal(ev.ambush, true);
  assert.equal(ev.evaded, false);
  assert.ok(ev.dmg >= 1);
  assert.equal(d.ambushed, true);
});

test("resolve: スキル damage は + str×3×skillMult、heal は自軍の兵、buff/debuff は先にかける", () => {
  const st = makeState();
  const d = addSquad(st, "d", 2, "ruby", T(6, 5), { troops: 200 });

  // caster（int 100・str 10・×1.5）：rng は 回避判定 0.999（d の int 0 なので回避なし）→ スキル 0
  const c = addSquad(st, "c", 6, "ocean", T(5, 5));
  let ev = resolve(st, db, seq(0.999, 0), c, d);
  // atk 100, def 150 → 50 − 37.5 = 12.5 → 13、+ 10×3×1.5 = 45
  assert.deepEqual(ev.skill, { name: "S6", kind: "damage", value: 45 });
  assert.equal(ev.dmg, 13 + 45);
  delete st.squads.c;

  d.troops = 200;
  const hl = addSquad(st, "hl", 7, "ocean", T(5, 5), { troops: 80 });
  ev = resolve(st, db, seq(0.999, 0), hl, d);
  assert.equal(ev.skill.kind, "heal");
  assert.equal(ev.skill.value, 30);
  assert.equal(hl.troops, 110);
  delete st.squads.hl;

  d.troops = 200;
  const bf = addSquad(st, "bf", 8, "ocean", T(5, 5));
  ev = resolve(st, db, seq(0.999, 0), bf, d);
  // atk 120, def 150 → 60 − 37.5 = 22.5 → 23
  assert.equal(ev.skill.kind, "buff");
  assert.equal(ev.dmg, 23);
  delete st.squads.bf;

  d.troops = 200;
  const db_ = addSquad(st, "dbf", 9, "ocean", T(5, 5));
  ev = resolve(st, db, seq(0.999, 0), db_, d);
  // atk 100, def 120 → 50 − 30 = 20
  assert.equal(ev.skill.kind, "debuff");
  assert.equal(ev.dmg, 20);
});

test("resolve: 最低 1 ダメージ", () => {
  const st = makeState();
  const a = addSquad(st, "a", 1, "ocean", T(5, 5), { troops: 0.0001 });
  const d = addSquad(st, "d", 4, "ruby", T(6, 5), { troops: 900 });
  const ev = resolve(st, db, NEVER, a, d);
  assert.equal(ev.dmg, 1);
});

// ---------- 反撃 ----------

test("resolve: 防御側の policy が fight なら 1 回反撃", () => {
  const st = makeState();
  const a = addSquad(st, "a", 1, "ocean", T(5, 5));
  const d = addSquad(st, "d", 2, "ruby", T(6, 5), { policy: "fight" });
  const ev = resolve(st, db, NEVER, a, d);
  assert.equal(ev.dmg, 25); // 100×0.5 − 100×0.25
  assert.equal(d.troops, 75);
  // 反撃（兵 75 のあと）：atk 50×1.75 = 87.5, def 100 → 43.75 − 25 = 18.75 → 19
  assert.deepEqual(ev.counter, { evaded: false, dmg: 19 });
  assert.equal(a.troops, 81);
});

test("resolve: 敗走した部隊は反撃しない。敗走で本拠地へ・orders 空・routed イベント", () => {
  const st = makeState();
  const a = addSquad(st, "a", 1, "ocean", T(5, 5));
  const d = addSquad(st, "d", 2, "ruby", T(6, 5), { troops: 10, policy: "fight", orders: [{ type: "rest" }] });
  const ev = resolve(st, db, NEVER, a, d);
  assert.equal(ev.result, "routed");
  assert.equal(ev.counter, null);
  assert.equal(d.status, "routed");
  assert.equal(d.troops, 0);
  assert.equal(d.tile, st.lands.ruby.home);
  assert.deepEqual(d.orders, []);
  assert.deepEqual(ev.followups, [{ t: "routed", squad: "d", home: st.lands.ruby.home }]);
});

test("resolve: 反撃で攻撃側が敗走することもある", () => {
  const st = makeState();
  const a = addSquad(st, "a", 1, "ocean", T(5, 5), { troops: 5 });
  const d = addSquad(st, "d", 4, "ruby", T(6, 5), { troops: 300, policy: "fight" });
  const ev = resolve(st, db, NEVER, a, d);
  assert.equal(a.status, "routed");
  assert.equal(a.tile, st.lands.ocean.home);
  assert.ok(ev.followups.some((e) => e.t === "routed" && e.squad === "a"));
});

// ---------- 砦 ----------

test("resolve: 砦は 守備兵 → 耐久。守備兵だけの砦も反撃する", () => {
  const st = makeState();
  const a = addSquad(st, "a", 1, "ocean", T(5, 5), { troops: 400 });
  const f = addFort(st, "f1", "rare", T(6, 5));
  // atk 50×5 = 250, def 40 → 125 − 10 = 115。兵 60 → 0、残り 55 → 耐久 40 → 0 で陥落
  const ev = resolve(st, db, NEVER, a, f);
  assert.equal(ev.dmg, 115);
  assert.equal(ev.result, "fort_fallen");
  assert.equal(ev.counter, null); // 落ちた砦は反撃しない

  const st2 = makeState();
  const b = addSquad(st2, "b", 1, "ocean", T(5, 5));
  const f2 = addFort(st2, "f2", "rare", T(6, 5));
  const ev2 = resolve(st2, db, NEVER, b, f2);
  // atk 100, def 40 → 50 − 10 = 40 → 兵 60 → 20
  assert.equal(ev2.result, "fort_damaged");
  assert.equal(f2.troops, 20);
  assert.equal(f2.durability, 40);
  // 反撃：atk 20×1.2 = 24, def 100 → 12 − 25 → 1
  assert.deepEqual(ev2.counter, { evaded: false, dmg: 1 });
  assert.equal(b.troops, 99);
});

test("resolve: エネミーの砦の陥落 → 持ち主・守備兵 30・耐久半分、SOUL と pending（プレイヤー）", () => {
  const st = makeState();
  const a = addSquad(st, "a", 1, "ocean", T(5, 5), { troops: 400 });
  const f = addFort(st, "f1", "rare", T(6, 5));
  const ev = resolve(st, db, NEVER, a, f);
  assert.equal(f.owner, "ocean");
  assert.equal(f.troops, 30);
  assert.equal(f.durability, 20);
  assert.equal(st.map.tiles[f.tile].owner, "ocean");
  const kinds = ev.followups.map((e) => e.t);
  assert.deepEqual(kinds, ["fort_fallen", "soul", "extension_offer"]);
  assert.deepEqual(ev.followups[0], { t: "fort_fallen", fort: "f1", by: "ocean", from: "enemy" });
  const soul = ev.followups[1].soul;
  assert.equal(soul.rarity, 3);
  assert.equal(soul.from, "f1");
  assert.ok(["front", "mid", "back"].includes(soul.role));
  assert.deepEqual(st.lands.ocean.souls, [soul]);
  assert.equal(st.pending.length, 2);
  const [ps, pe] = st.pending;
  assert.equal(ps.kind, "soul");
  assert.equal(ps.land, "ocean");
  assert.equal(ps.candidates.length, 3);
  assert.equal(pe.kind, "extension");
  assert.equal(pe.fort, "f1");
  assert.equal(pe.candidates.length, 8);
});

test("resolve: CPU のランドが落とすと pending は作らず、その場で受け取る", () => {
  const st = makeState();
  const a = addSquad(st, "a", 1, "ruby", T(5, 5), { troops: 400 });
  const f = addFort(st, "f1", "epic", T(6, 5), { troops: 0, durability: 1 });
  const before = Object.keys(st.squads).length;
  const ev = resolve(st, db, NEVER, a, f);
  assert.equal(ev.result, "fort_fallen");
  assert.equal(st.pending.length, 0);
  assert.equal(st.lands.ruby.souls.length, 0); // 使った
  assert.equal(Object.keys(st.squads).length, before + 1);
  const added = Object.values(st.squads).find((s) => s.id !== "a");
  assert.equal(added.land, "ruby");
  assert.equal(added.tile, st.lands.ruby.home);
  assert.equal(st.lands.ruby.extensions.length, 1);
  assert.equal(f.durability, 40);
});

test("resolve: Legendary 砦の陥落で clear。ランド同士の砦は報酬なし", () => {
  const st = makeState();
  const a = addSquad(st, "a", 1, "ocean", T(5, 5));
  const f = addFort(st, "fL", "legendary", T(6, 5), { troops: 0, durability: 1 });
  const ev = resolve(st, db, NEVER, a, f);
  assert.deepEqual(ev.followups.at(-1), { t: "clear", land: "ocean" });

  const st2 = makeState();
  const b = addSquad(st2, "b", 1, "ruby", T(5, 5));
  const f2 = addFort(st2, "f2", "rare", T(6, 5), { owner: "ocean", troops: 0, durability: 1 });
  const ev2 = resolve(st2, db, NEVER, b, f2);
  assert.deepEqual(ev2.followups.map((e) => e.t), ["fort_fallen"]);
  assert.equal(ev2.followups[0].from, "ocean");
  assert.equal(st2.pending.length, 0);
});

test("resolve: 砦に立つ味方部隊が先に受ける。intercept は反撃 ×1.3、defend は溢れた耐久ダメージ ×0.6", () => {
  const st = makeState();
  const a = addSquad(st, "a", 1, "ruby", T(5, 5));
  const f = addFort(st, "f1", "rare", T(6, 5), { owner: "ocean", stance: "intercept" });
  const g = addSquad(st, "g", 2, "ocean", T(6, 5)); // policy ask でも intercept なら反撃
  const ev = resolve(st, db, NEVER, a, f);
  assert.equal(ev.defender, "g");
  assert.equal(g.troops, 75);
  assert.equal(f.troops, 60);
  // 反撃：atk 87.5 × 1.3 = 113.75, def 100 → 56.875 − 25 = 31.875 → 32
  assert.equal(ev.counter.dmg, 32);

  // defend：守備部隊を超えた分が砦へ。守備兵 → 耐久（×0.6）
  const st2 = makeState();
  const b = addSquad(st2, "b", 1, "ruby", T(5, 5), { troops: 900 });
  const f2 = addFort(st2, "f2", "rare", T(6, 5), { owner: "ocean", troops: 10 });
  const g2 = addSquad(st2, "g2", 2, "ocean", T(6, 5), { troops: 10 });
  const ev2 = resolve(st2, db, NEVER, b, f2);
  // atk 500, def 55 → 250 − 13.75 = 236.25 → 236。部隊 10、砦の兵 10、残り 216 × 0.6 = 130 → 耐久 0
  assert.equal(ev2.dmg, 236);
  assert.equal(g2.status, "routed");
  assert.equal(ev2.result, "fort_fallen");

  const st3 = makeState();
  const c = addSquad(st3, "c", 1, "ruby", T(5, 5), { troops: 150 });
  const f3 = addFort(st3, "f3", "rare", T(6, 5), { owner: "ocean", troops: 0 });
  addSquad(st3, "g3", 2, "ocean", T(6, 5), { troops: 10 });
  resolve(st3, db, NEVER, c, f3);
  // atk 125, def 55 → 62.5 − 13.75 = 48.75 → 49。部隊 10、残り 39 × 0.6 = 23 → 耐久 17
  assert.equal(f3.durability, 17);
});

// ---------- 本拠地 ----------

test("resolve: 本拠地は立っている部隊が先に受け、いなければ耐久。0 で脱落・部隊と砦が移る", () => {
  const st = makeState();
  const home = st.lands.ruby.home;
  const a = addSquad(st, "a", 1, "ocean", T(14, 9), { troops: 100 });
  const g = addSquad(st, "g", 2, "ruby", home, { troops: 50 });
  let ev = resolve(st, db, NEVER, a, { home: "ruby" });
  assert.equal(ev.defender, "g");
  assert.equal(g.troops, 50 - 31); // atk 100, def 75 → 50 − 18.75 = 31.25 → 31
  assert.equal(st.lands.ruby.homeDurability, undefined);

  g.troops = 0;
  g.status = "routed";
  ev = resolve(st, db, NEVER, a, { home: "ruby" });
  // atk 100, def 40×2 = 80 → 50 − 20 = 30
  assert.equal(ev.defender, "ruby");
  assert.equal(ev.result, "home_damaged");
  assert.equal(st.lands.ruby.homeDurability, 70);

  const f = addFort(st, "f9", "rare", T(3, 3), { owner: "ruby" });
  const far = addSquad(st, "far", 2, "ruby", T(18, 2));
  st.lands.ruby.homeDurability = 10;
  ev = resolve(st, db, NEVER, a, { home: "ruby" });
  assert.equal(ev.result, "home_fallen");
  assert.equal(st.lands.ruby.alive, false);
  const hf = ev.followups.find((e) => e.t === "home_fallen");
  assert.deepEqual(hf.heroes.sort(), ["far", "g"]);
  assert.equal(far.land, "ocean");
  assert.equal(far.tile, st.lands.ocean.home);
  assert.equal(f.owner, "ocean");
  assert.equal(st.map.tiles[f.tile].owner, "ocean");
});

test("resolve: 同じ rng なら同じ結果（決定的）", () => {
  const run = () => {
    const st = makeState();
    const a = addSquad(st, "a", 5, "ocean", T(5, 5));
    const d = addSquad(st, "d", 7, "ruby", T(6, 5), { policy: "fight" });
    let s = 42;
    const rng = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const evs = [];
    for (let i = 0; i < 5; i++) evs.push(resolve(st, db, rng, a, d));
    return JSON.stringify(evs);
  };
  assert.equal(run(), run());
});
