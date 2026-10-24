// heroes 班のテスト：souls.js。node --test tests/souls.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { makeRng } from "../js/engine/rng.js";
import { candidates, accept, extensionCandidates, acceptExtension, equip } from "../js/engine/souls.js";
import { START_TROOPS_PER_LEAD } from "../js/engine/tuning.js";

const heroList = JSON.parse(fs.readFileSync(new URL("../data/heroes.json", import.meta.url), "utf8"));
const extList = JSON.parse(fs.readFileSync(new URL("../data/extensions.json", import.meta.url), "utf8"));
const db = {
  heroes: Object.fromEntries(heroList.map((h) => [h.id, h])),
  heroList,
  extensions: Object.fromEntries(extList.map((e) => [e.id, e])),
};

/** 契約 §2 の形の最小の state */
function makeState() {
  return {
    version: 1,
    seed: 99,
    day: 3,
    phase: "orders",
    playerLand: "ocean",
    map: { w: 48, h: 28, tiles: [] },
    lands: {
      ocean: {
        id: "ocean", cpu: false, alive: true, home: 1234,
        res: { pop: 100, food: 150, gum: 120, mat: 60 },
        explored: [], souls: [], extensions: [], fortPoints: 0,
        points: { week1: 0, week2: 0, week3: 0, week4: 0 },
      },
    },
    squads: {},
    forts: {},
    builds: {},
    nextId: 1,
    log: [],
    notices: [],
    pending: [],
    ended: null,
  };
}

// ---------- candidates ----------

test("candidates: role と rarity を守り、3 体が重ならず、使用済みを避ける", () => {
  for (const role of ["front", "mid", "back"]) {
    for (const rarity of [3, 4, 5]) {
      for (let seed = 0; seed < 30; seed++) {
        const rng = makeRng(seed * 7 + rarity);
        const used = new Set([heroList[0].id, heroList[1].id]);
        const ids = candidates(rng, db, { role, rarity, from: "f1" }, used);
        assert.equal(ids.length, 3);
        assert.equal(new Set(ids).size, 3);
        for (const id of ids) {
          const h = db.heroes[id];
          assert.ok(h, `unknown ${id}`);
          assert.equal(h.cls.main, role);
          assert.ok(h.rarity === rarity || h.rarity === Math.min(5, rarity + 1), `rarity ${h.rarity} for soul ${rarity}`);
          assert.ok(!used.has(id));
        }
      }
    }
  }
});

test("candidates: 10% で 1 段上が混ざる（Legendary は上がらない）", () => {
  let up = 0;
  const N = 400;
  for (let seed = 0; seed < N; seed++) {
    const ids = candidates(makeRng(seed), db, { role: "front", rarity: 3, from: "f1" }, new Set());
    if (ids.some((id) => db.heroes[id].rarity === 4)) up++;
  }
  // 3 枠のどれかが上がる確率は 1 − 0.9^3 ≈ 27%
  assert.ok(up > N * 0.15 && up < N * 0.4, `up ${up}/${N}`);
  for (let seed = 0; seed < 50; seed++) {
    const ids = candidates(makeRng(seed), db, { role: "back", rarity: 5, from: "f1" }, new Set());
    for (const id of ids) assert.equal(db.heroes[id].rarity, 5);
  }
});

test("candidates: そのレアリティが尽きたら隣のレアリティで埋める", () => {
  const used = new Set(heroList.filter((h) => h.cls.main === "mid" && h.rarity === 5).map((h) => h.id));
  const ids = candidates(makeRng(1), db, { role: "mid", rarity: 5, from: "f1" }, used);
  assert.equal(ids.length, 3);
  for (const id of ids) {
    assert.equal(db.heroes[id].cls.main, "mid");
    assert.equal(db.heroes[id].rarity, 4);
  }
  // 配列で渡しても動く
  const ids2 = candidates(makeRng(1), db, { role: "mid", rarity: 5, from: "f1" }, [...used]);
  assert.deepEqual(ids2, ids);
});

// ---------- accept ----------

test("accept: 本拠地に部隊ができ、pending と souls から外れる", () => {
  const state = makeState();
  const soul = { role: "front", rarity: 3, from: "f1" };
  state.lands.ocean.souls.push(soul);
  const cands = candidates(makeRng(3), db, soul, new Set());
  const pending = { kind: "soul", land: "ocean", soul, candidates: cands };
  state.pending.push(pending);

  const squad = accept(state, db, "ocean", pending, cands[1]);
  const hero = db.heroes[cands[1]];
  assert.deepEqual(squad, {
    id: "s1", heroId: hero.id, land: "ocean", tile: 1234, troops: hero.params.lead * START_TROOPS_PER_LEAD,
    mustered: hero.params.lead * START_TROOPS_PER_LEAD, ap: 0, // SPEC-113 §2.1：定員 = 初期の兵
    orders: [], policy: "ask", status: "ok", equip: null, ambushed: false, morale: 60, // SPEC-113：士気 60 で始まる
  });
  assert.equal(state.squads.s1, squad);
  assert.equal(Object.keys(state.squads).length, 1);
  assert.equal(state.nextId, 2);
  assert.deepEqual(state.pending, []);
  assert.deepEqual(state.lands.ocean.souls, []);

  // 2 体目は s2。usedHeroIds は state.squads の heroId 全部
  const used = new Set(Object.values(state.squads).map((sq) => sq.heroId));
  const cands2 = candidates(makeRng(4), db, soul, used);
  assert.ok(!cands2.includes(hero.id));
  const p2 = { kind: "soul", land: "ocean", soul: { ...soul }, candidates: cands2 };
  state.pending.push(p2);
  const s2 = accept(state, db, "ocean", p2, cands2[0]);
  assert.equal(s2.id, "s2");
  assert.equal(Object.keys(state.squads).length, 2);
  assert.equal(JSON.stringify(state).length > 0, true, "state は JSON にできる");
});

// ---------- extensions ----------

test("extensionCandidates: 8 枚、重複なし、db にあるもの。未所持を先に出す", () => {
  const land = makeState().lands.ocean;
  const ids = extensionCandidates(makeRng(11), db, land);
  assert.equal(ids.length, 8);
  assert.equal(new Set(ids).size, 8);
  for (const id of ids) assert.ok(db.extensions[id]);

  land.extensions = extList.slice(0, 6).map((e) => e.id);
  const ids2 = extensionCandidates(makeRng(11), db, land);
  assert.equal(ids2.length, 8);
  const fresh = extList.slice(6).map((e) => e.id);
  assert.deepEqual([...ids2.slice(0, 6)].sort(), [...fresh].sort(), "未所持の 6 種が先");
});

test("acceptExtension: liked から 1 つ。空なら candidates から。land.extensions に足し pending を外す", () => {
  const state = makeState();
  const cands = extensionCandidates(makeRng(5), db, state.lands.ocean);
  const pending = { kind: "extension", land: "ocean", fort: "f2", candidates: cands };
  state.pending.push(pending);

  const liked = [cands[2], cands[5], "ext_not_in_candidates"];
  const got = acceptExtension(state, db, "ocean", pending, liked);
  assert.ok([cands[2], cands[5]].includes(got));
  assert.deepEqual(state.lands.ocean.extensions, [got]);
  assert.deepEqual(state.pending, []);

  const p2 = { kind: "extension", land: "ocean", fort: "f3", candidates: cands };
  state.pending.push(p2);
  const got2 = acceptExtension(state, db, "ocean", p2, []);
  assert.ok(cands.includes(got2));
  assert.equal(state.lands.ocean.extensions.length, 2);
  assert.deepEqual(state.pending, []);

  // 同じ状況なら同じ結果（Math.random を使っていない）
  const s1 = makeState();
  const s2 = makeState();
  const pa = { kind: "extension", land: "ocean", fort: "f2", candidates: cands };
  const pb = { kind: "extension", land: "ocean", fort: "f2", candidates: cands };
  assert.equal(acceptExtension(s1, db, "ocean", pa, []), acceptExtension(s2, db, "ocean", pb, []));
});

test("equip: 付け替えで外したものは land.extensions へ戻る。持っていないものは付かない", () => {
  const state = makeState();
  const land = state.lands.ocean;
  land.extensions = ["ext_boots", "ext_grail"];
  state.squads.s1 = {
    id: "s1", heroId: heroList[0].id, land: "ocean", tile: 1234, troops: 30, ap: 0,
    orders: [], policy: "ask", status: "ok", equip: null, ambushed: false,
  };

  assert.equal(equip(state, db, "s1", "ext_boots"), true);
  assert.equal(state.squads.s1.equip, "ext_boots");
  assert.deepEqual(land.extensions, ["ext_grail"]);

  assert.equal(equip(state, db, "s1", "ext_grail"), true);
  assert.equal(state.squads.s1.equip, "ext_grail");
  assert.deepEqual(land.extensions, ["ext_boots"]);

  assert.equal(equip(state, db, "s1", "ext_aegis"), false, "持っていない");
  assert.equal(state.squads.s1.equip, "ext_grail");
  assert.deepEqual(land.extensions, ["ext_boots"]);

  assert.equal(equip(state, db, "s1", "ext_grail"), true, "同じものは何もしない");
  assert.deepEqual(land.extensions, ["ext_boots"]);

  assert.equal(equip(state, db, "s1", null), true);
  assert.equal(state.squads.s1.equip, null);
  assert.deepEqual([...land.extensions].sort(), ["ext_boots", "ext_grail"]);

  assert.equal(equip(state, db, "s1", null), true, "外した状態で外しても何も起きない");
  assert.equal(land.extensions.length, 2);
  assert.equal(equip(state, db, "s9", "ext_boots"), false, "居ない部隊");
});
