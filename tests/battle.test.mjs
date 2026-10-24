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
  // 知力 50：回避もスキルも半々で起きる（predict の幅を確かめる）
  hero(12, "gunner", "mid", { int: 50, str: 12 }, "damage"),
  hero(13, "gunner", "mid", { int: 50, str: 12 }, "heal"),
  hero(14, "commander", "front", { int: 50 }, "buff"),
  hero(15, "caster", "back", { int: 50, str: 12 }, "debuff"),
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

// 士気は 50（士気係数 ×1.00）にして、SPEC-109 §7.2 の式の数字をそのまま追えるようにする。
// 士気係数そのものは下の「士気」のテストで見る（SPEC-113 §1）。
function addSquad(state, id, heroId, landId, tile, extra = {}) {
  const s = {
    id, heroId, land: landId, tile, troops: 100, ap: 6, orders: [],
    policy: "ask", status: "ok", equip: null, ambushed: false, morale: 50, ...extra,
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

test("fortPower: rank の lead 相当（砦は士気 60 扱いで ×1.05）", () => {
  const st = makeState();
  const f = addFort(st, "f1", "rare", T(8, 8));
  const p = fortPower(st, db, f);
  assert.ok(Math.abs(p.atk - 20 * 1.6 * 1.05) < 1e-9);
  assert.ok(Math.abs(p.def - 40 * 1.05) < 1e-9);
  f.durability = 20;
  assert.ok(Math.abs(fortPower(st, db, f).def - 30 * 1.05) < 1e-9);
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

  // 受けた側は「負け」で士気が下がるので、毎回 50 に戻して式だけを見る
  d.troops = 200;
  d.morale = 50;
  const hl = addSquad(st, "hl", 7, "ocean", T(5, 5), { troops: 80 });
  ev = resolve(st, db, seq(0.999, 0), hl, d);
  assert.equal(ev.skill.kind, "heal");
  assert.equal(ev.skill.value, 30);
  assert.equal(hl.troops, 110);
  delete st.squads.hl;

  d.troops = 200;
  d.morale = 50;
  const bf = addSquad(st, "bf", 8, "ocean", T(5, 5));
  ev = resolve(st, db, seq(0.999, 0), bf, d);
  // atk 120, def 150 → 60 − 37.5 = 22.5 → 23
  assert.equal(ev.skill.kind, "buff");
  assert.equal(ev.dmg, 23);
  delete st.squads.bf;

  d.troops = 200;
  d.morale = 50;
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
  assert.deepEqual(ev.followups, [
    { t: "routed", squad: "d", home: st.lands.ruby.home },
    { t: "morale", squad: "d", delta: -20, reason: "routed", value: 30 }, // 敗走は士気 30 に
    { t: "morale", squad: "a", delta: 8, reason: "win", value: 58 }, // 敗走させた側は +8
  ]);
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
  const kinds = ev.followups.filter((e) => e.t !== "morale").map((e) => e.t);
  assert.deepEqual(kinds, ["fort_fallen", "soul", "extension_offer"]);
  // 砦を落とした：勝ち +8、そのランドの全部隊 +5
  assert.deepEqual(ev.followups.filter((e) => e.t === "morale").map((e) => [e.squad, e.reason, e.delta]), [["a", "win", 8], ["a", "fort", 5]]);
  assert.equal(a.morale, 63);
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
  assert.deepEqual(ev.followups.filter((e) => e.t !== "morale").at(-1), { t: "clear", land: "ocean" });

  const st2 = makeState();
  const b = addSquad(st2, "b", 1, "ruby", T(5, 5));
  const f2 = addFort(st2, "f2", "rare", T(6, 5), { owner: "ocean", troops: 0, durability: 1 });
  const ev2 = resolve(st2, db, NEVER, b, f2);
  assert.deepEqual(ev2.followups.filter((e) => e.t !== "morale").map((e) => e.t), ["fort_fallen"]);
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
  // atk 100, def 40×2×1.05（本拠地は士気 60 扱い）= 84 → 50 − 21 = 29
  assert.equal(ev.defender, "ruby");
  assert.equal(ev.result, "home_damaged");
  assert.equal(st.lands.ruby.homeDurability, 71);

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

// ---------- 士気（SPEC-113 §1・§1.1・§1.2） ----------

const moraleOf = (s) => s.morale;
const moraleEvents = (ev) => ev.followups.filter((e) => e.t === "morale").map((e) => [e.squad, e.reason, e.delta, e.value]);

test("power: 士気係数 0.75 + 0.005 × 士気 を atk・def に掛ける（無ければ 60 扱い）", () => {
  const st = makeState();
  const a = addSquad(st, "a", 1, "ocean", T(5, 5));
  assert.deepEqual(power(st, db, a), { atk: 100, def: 100 }); // 50 → ×1.00
  a.morale = 100;
  assert.deepEqual(power(st, db, a), { atk: 125, def: 125 });
  a.morale = 0;
  assert.deepEqual(power(st, db, a), { atk: 75, def: 75 });
  delete a.morale;
  const p = power(st, db, a);
  assert.ok(Math.abs(p.atk - 105) < 1e-9 && Math.abs(p.def - 105) < 1e-9);
});

test("resolve: スキルの士気（buff 自分 +10・heal 自分 +6・debuff 相手 −10・damage なし）", () => {
  const cases = [
    [8, "buff", [["x", "skill", 10, 60]]],
    [7, "heal", [["x", "skill", 6, 56]]],
    [9, "debuff", [["d", "skill", -10, 40]]],
    [5, "damage", []],
  ];
  for (const [heroId, kind, want] of cases) {
    const st = makeState();
    const d = addSquad(st, "d", 2, "ruby", T(6, 5), { troops: 500 }); // 受けた兵 < 与えた兵 にしない（負けの −8 を混ぜない）
    const x = addSquad(st, "x", heroId, "ocean", T(5, 5), { troops: 80 });
    const ev = resolve(st, db, seq(0.999, 0), x, d);
    assert.equal(ev.skill.kind, kind);
    const got = moraleEvents(ev).filter((m) => m[1] === "skill");
    assert.deepEqual(got, want, kind);
  }
});

test("resolve: スキルの士気は反撃より前に効く（debuff で下がった相手は弱く反撃する）", () => {
  const st = makeState();
  const d = addSquad(st, "d", 2, "ruby", T(6, 5), { troops: 200, policy: "fight" });
  const x = addSquad(st, "x", 15, "ocean", T(5, 5), { troops: 200 });
  const st2 = makeState();
  const d2 = addSquad(st2, "d", 2, "ruby", T(6, 5), { troops: 200, policy: "fight" });
  const x2 = addSquad(st2, "x", 15, "ocean", T(5, 5), { troops: 200 });
  // 1 回目：回避なし → スキル発動（debuff）→ 反撃（回避なし・相手はスキルを持つが int 0）
  const ev = resolve(st, db, seq(0.999, 0, 0.999), x, d);
  // 2 回目：スキル不発
  const ev2 = resolve(st2, db, seq(0.999, 0.999, 0.999), x2, d2);
  assert.equal(ev.skill.kind, "debuff");
  assert.equal(ev2.skill, null);
  assert.equal(moraleOf(d) < moraleOf(d2), true);
  assert.ok(ev.counter.dmg <= ev2.counter.dmg);
});

test("resolve: 奇襲を受けた部隊は士気 −15。負け（受けた兵 > 与えた兵）は −8", () => {
  const st = makeState();
  const s = addSquad(st, "s", 11, "ocean", T(9, 5), { troops: 300 }); // sniper 射程 3・int 0
  const d = addSquad(st, "d", 2, "ruby", T(6, 5), { troops: 200 });
  const ev = resolve(st, db, NEVER, s, d);
  assert.equal(ev.ambush, true);
  // 奇襲 −15 → 35、反撃なし（ask）なので受けた兵 > 与えた兵 で −8 → 27
  assert.deepEqual(moraleEvents(ev), [["d", "ambushed", -15, 35], ["d", "lose", -8, 27]]);
  assert.equal(d.morale, 27);
  assert.equal(s.morale, 50); // 攻め手は勝ちでも負けでもない
});

test("resolve: 反撃で攻め手を敗走させた守り手は +8、敗走した部隊は士気 30", () => {
  const st = makeState();
  const a = addSquad(st, "a", 1, "ocean", T(5, 5), { troops: 5, morale: 90 });
  const d = addSquad(st, "d", 4, "ruby", T(6, 5), { troops: 300, policy: "fight" });
  const ev = resolve(st, db, NEVER, a, d);
  assert.equal(a.status, "routed");
  assert.equal(a.morale, 30);
  assert.equal(d.morale, 58);
  assert.deepEqual(moraleEvents(ev), [["a", "routed", -60, 30], ["d", "win", 8, 58]]);
});

test("resolve: 砦を落としたら勝ち +8 と、そのランドの全部隊 +5（敗走中は除く）", () => {
  const st = makeState();
  const a = addSquad(st, "a", 1, "ruby", T(5, 5), { troops: 400 });
  const b = addSquad(st, "b", 2, "ruby", T(1, 9), { morale: 98 });
  const r = addSquad(st, "r", 2, "ruby", st.lands.ruby.home, { troops: 0, status: "routed", morale: 30 });
  const o = addSquad(st, "o", 2, "ocean", T(2, 2));
  const f = addFort(st, "f1", "rare", T(6, 5), { troops: 0, durability: 1 });
  resolve(st, db, NEVER, a, f);
  assert.equal(a.morale, 63);
  assert.equal(b.morale, 100); // 上限 100
  assert.equal(r.morale, 30);
  assert.equal(o.morale, 50);
});

test("resolve: 本拠地が落ちて相手に従った部隊は士気 30", () => {
  const st = makeState();
  const a = addSquad(st, "a", 1, "ocean", T(14, 9), { troops: 100 });
  const far = addSquad(st, "far", 2, "ruby", T(18, 2), { morale: 80 });
  st.lands.ruby.homeDurability = 5;
  const ev = resolve(st, db, NEVER, a, { home: "ruby" });
  assert.equal(ev.result, "home_fallen");
  assert.equal(far.land, "ocean");
  assert.equal(far.morale, 30);
  assert.ok(moraleEvents(ev).some((m) => m[0] === "far" && m[1] === "surrender" && m[3] === 30));
  assert.ok(moraleEvents(ev).some((m) => m[0] === "a" && m[1] === "win"));
});

test("resolve: 士気の上限 100・下限 0", () => {
  const st = makeState();
  const x = addSquad(st, "x", 8, "ocean", T(5, 5), { morale: 95 });
  const d = addSquad(st, "d", 2, "ruby", T(6, 5), { troops: 500 });
  resolve(st, db, seq(0.999, 0), x, d);
  assert.equal(x.morale, 100);
  const st2 = makeState();
  const s = addSquad(st2, "s", 11, "ocean", T(9, 5), { troops: 300 });
  const d2 = addSquad(st2, "d", 2, "ruby", T(6, 5), { troops: 200, morale: 5 });
  resolve(st2, db, NEVER, s, d2);
  assert.equal(d2.morale, 0);
});

// ---------- predict（SPEC-113 §6.3） ----------

import { predict, PREDICT_LABELS } from "../js/engine/battle.js";
import { makeRng } from "../js/engine/rng.js";

/** predict の幅に、rng を変えた resolve の結果が 200 回とも入るか */
function checkPredict(build, label) {
  const st0 = build();
  const { attackerId, target } = st0.__case;
  const before = JSON.stringify(st0);
  const p = predict(st0, db, st0.squads[attackerId], target(st0));
  assert.equal(JSON.stringify(st0), before, `${label}: predict は state を変えない`);
  for (let i = 0; i < 200; i++) {
    const st = build();
    const a = st.squads[attackerId];
    const t = target(st);
    const defSquadId = p.target === "squad" || (p.defenderId && st.squads[p.defenderId]) ? p.defenderId : null;
    const ev = resolve(st, db, makeRng(1000 + i), a, t);
    const at = Math.max(0, a.troops);
    assert.ok(p.attacker.min <= at && at <= p.attacker.max, `${label} #${i}: 攻め手 ${at} が ${p.attacker.min}〜${p.attacker.max} の外`);
    let dt;
    if (defSquadId) dt = Math.max(0, st.squads[defSquadId].troops);
    else if (p.target === "fort") dt = ev.result === "fort_fallen" ? 0 : st.forts[t.id].troops;
    else dt = 0;
    assert.ok(p.defender.min <= dt && dt <= p.defender.max, `${label} #${i}: 守り手 ${dt} が ${p.defender.min}〜${p.defender.max} の外`);
    if (p.fort) {
      const fd = ev.result === "fort_fallen" ? 0 : st.forts[t.id].durability;
      assert.ok(p.fort.durability.min <= fd && fd <= p.fort.durability.max, `${label} #${i}: 耐久`);
    }
    if (p.home) {
      const hd = st.lands[t.home].homeDurability ?? 100;
      assert.ok(p.home.durability.min <= hd && hd <= p.home.durability.max, `${label} #${i}: 本拠地の耐久`);
    }
  }
  return p;
}

test("predict: 部隊 × 部隊（回避・スキル・反撃あり）で min ≤ 実際 ≤ max（rng を変えて 200 回）", () => {
  const pairs = [[12, 13], [13, 15], [14, 12], [15, 14], [12, 12], [5, 7], [1, 2]];
  let spread = 0;
  for (const [ah, dh] of pairs) {
    const build = () => {
      const st = makeState();
      addSquad(st, "a", ah, "ocean", T(5, 5), { troops: 150 });
      addSquad(st, "d", dh, "ruby", T(6, 5), { troops: 120, policy: "fight" });
      st.__case = { attackerId: "a", target: (s) => s.squads.d };
      return st;
    };
    const p = checkPredict(build, `hero ${ah} vs ${dh}`);
    assert.ok(p.attacker.min <= p.attacker.max && p.defender.min <= p.defender.max);
    assert.ok(PREDICT_LABELS.some((l) => l.label === p.label));
    assert.equal(p.target, "squad");
    assert.ok(Array.isArray(p.excludes) && p.excludes.length > 0);
    if (p.attacker.min < p.attacker.max && p.defender.min < p.defender.max) spread++;
  }
  assert.ok(spread >= 4, "運で幅が出る組み合わせを確かめている");
});

test("predict: 砦（守備兵だけ・守備部隊あり）と本拠地でも min ≤ 実際 ≤ max", () => {
  checkPredict(() => {
    const st = makeState();
    addSquad(st, "a", 12, "ocean", T(5, 5), { troops: 260 });
    addFort(st, "f1", "rare", T(6, 5));
    st.__case = { attackerId: "a", target: (s) => s.forts.f1 };
    return st;
  }, "砦（守備兵だけ）");
  checkPredict(() => {
    const st = makeState();
    addSquad(st, "a", 14, "ruby", T(5, 5), { troops: 400 });
    addFort(st, "f1", "rare", T(6, 5), { owner: "ocean", troops: 10, durability: 20, stance: "intercept" });
    addSquad(st, "g", 13, "ocean", T(6, 5), { troops: 60 });
    st.__case = { attackerId: "a", target: (s) => s.forts.f1 };
    return st;
  }, "砦（守備部隊あり）");
  checkPredict(() => {
    const st = makeState();
    addSquad(st, "a", 12, "ocean", T(14, 9), { troops: 200 });
    st.lands.ruby.homeDurability = 40;
    st.__case = { attackerId: "a", target: () => ({ home: "ruby" }) };
    return st;
  }, "本拠地");
});

test("predict: ラベルは与える見込みの中央 ÷ 受ける見込みの中央", () => {
  const st = makeState();
  const a = addSquad(st, "a", 1, "ocean", T(5, 5), { troops: 400 });
  const d = addSquad(st, "d", 2, "ruby", T(6, 5), { troops: 20, policy: "fight" });
  assert.equal(predict(st, db, a, d).label, "overwhelm");
  const st2 = makeState();
  const a2 = addSquad(st2, "a", 1, "ocean", T(5, 5), { troops: 10 });
  const d2 = addSquad(st2, "d", 4, "ruby", T(6, 5), { troops: 400, policy: "fight" });
  assert.equal(predict(st2, db, a2, d2).label, "hopeless");
  const st3 = makeState();
  const a3 = addSquad(st3, "a", 1, "ocean", T(5, 5), { troops: 100 });
  const d3 = addSquad(st3, "d", 2, "ruby", T(6, 5), { troops: 100, policy: "fight" });
  // 与える 25・受ける 19（反撃）→ 1.3 で互角
  const p3 = predict(st3, db, a3, d3);
  assert.deepEqual([p3.dealt, p3.taken], [{ min: 25, max: 25 }, { min: 19, max: 19 }]);
  assert.equal(p3.label, "even");
});
