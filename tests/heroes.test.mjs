// heroes 班のテスト：rng.js と heroes.js。node --test tests/heroes.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { makeRng, rngInt, pick, shuffle, hashStr } from "../js/engine/rng.js";
import {
  toParams, classify, statType, skillKindOf, toneOf, effectiveParams, troopCap, visionOf, rangeOf,
  subMods, starterHeroes, SUBS_BY_MAIN, TONES,
} from "../js/engine/heroes.js";

const heroList = JSON.parse(fs.readFileSync(new URL("../data/heroes.json", import.meta.url), "utf8"));
const extList = JSON.parse(fs.readFileSync(new URL("../data/extensions.json", import.meta.url), "utf8"));
const db = {
  heroes: Object.fromEntries(heroList.map((h) => [h.id, h])),
  heroList,
  extensions: Object.fromEntries(extList.map((e) => [e.id, e])),
};
const ALL_SUBS = Object.values(SUBS_BY_MAIN).flat();

// 画像はこのリポジトリに無い（MCH リポジトリ内の相対パスで持つ）。clone があればそこで実在を確かめる。
// 場所は MCH_REPO で変えられる。無い環境では実在の確認だけ飛ばす。
const MCH_REPO = process.env.MCH_REPO || "/home/user/mycryptoheroes";
const HAS_MCH = fs.existsSync(path.join(MCH_REPO, "Image"));
const imageExists = (rel) => !HAS_MCH || fs.existsSync(path.join(MCH_REPO, rel));

// ---------- rng ----------

test("makeRng: 同じ seed で同じ列、0 以上 1 未満", () => {
  const a = makeRng(12345);
  const b = makeRng(12345);
  for (let i = 0; i < 100; i++) {
    const v = a();
    assert.equal(v, b());
    assert.ok(v >= 0 && v < 1);
  }
  assert.notEqual(makeRng(1)(), makeRng(2)());
});

test("rngInt は lo..hi を両端とも出す。pick / shuffle / hashStr", () => {
  const rng = makeRng(7);
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const v = rngInt(rng, 2, 5);
    assert.ok(v >= 2 && v <= 5);
    seen.add(v);
  }
  assert.deepEqual([...seen].sort(), [2, 3, 4, 5]);
  assert.ok(["a", "b", "c"].includes(pick(rng, ["a", "b", "c"])));
  assert.equal(pick(rng, []), undefined);
  const src = [1, 2, 3, 4, 5, 6];
  const sh = shuffle(rng, src);
  assert.deepEqual(src, [1, 2, 3, 4, 5, 6], "元の配列は変えない");
  assert.deepEqual([...sh].sort(), src);
  assert.equal(hashStr("abc"), hashStr("abc"));
  assert.notEqual(hashStr("abc"), hashStr("abd"));
  assert.ok(Number.isInteger(hashStr("x")) && hashStr("x") >= 0);
});

// ---------- toParams ----------

test("toParams: コナン・ドイル（hp192 phy25 int69 agi138）", () => {
  // act 3 + 9.2 → 13 / lead (48+25+69+138)/5 = 56 / str 94/14 = 6.7 → 7
  // int 37.95 → 38 / gov 207/6 = 34.5 → 35 / pol 163/6 = 27.2 → 28
  assert.deepEqual(toParams({ hp: 192, phy: 25, int: 69, agi: 138 }), {
    act: 13, lead: 56, str: 7, int: 38, gov: 35, pol: 28,
  });
});

test("toParams: 狼王ロボ（hp345 phy66 int69 agi46）", () => {
  // act 3 + 3.07 → 7 / lead (86.25+66+69+46)/5 = 53.45 → 54 / str 135/14 = 9.64 → 10
  // int 37.95 → 38 / gov 115/6 = 19.2 → 20 / pol 112/6 = 18.7 → 19
  assert.deepEqual(toParams({ hp: 345, phy: 66, int: 69, agi: 46 }), {
    act: 7, lead: 54, str: 10, int: 38, gov: 20, pol: 19,
  });
});

test("toParams: 割り切れる値は切り上げで増えない（浮動小数のごみを吸う）", () => {
  // 100 × 0.55 は JS では 55.00000000000001 になる
  const p = toParams({ hp: 400, phy: 50, int: 100, agi: 150 });
  assert.equal(p.int, 55);
  assert.equal(p.act, 13); // 3 + 10
  assert.equal(p.lead, 80); // (100+50+100+150)/5
});

// ---------- classify / skillKindOf / toneOf ----------

test("statType: 最大の能力。同点は PHY → INT → AGI", () => {
  assert.equal(statType({ phy: 100, int: 50, agi: 50 }), "PHY");
  assert.equal(statType({ phy: 50, int: 100, agi: 50 }), "INT");
  assert.equal(statType({ phy: 50, int: 50, agi: 100 }), "AGI");
  assert.equal(statType({ phy: 100, int: 100, agi: 100 }), "PHY");
  assert.equal(statType({ phy: 50, int: 100, agi: 100 }), "INT");
});

test("classify: 型と大分類が対応し、小分類は大分類の中", () => {
  for (const [stats, kind, main] of [
    [{ hp: 300, phy: 150, int: 50, agi: 60 }, "damage", "front"],
    [{ hp: 300, phy: 50, int: 150, agi: 60 }, "damage", "back"],
    [{ hp: 300, phy: 50, int: 60, agi: 150 }, "damage", "mid"],
  ]) {
    const c = classify(stats, kind);
    assert.equal(c.main, main);
    assert.ok(SUBS_BY_MAIN[main].includes(c.sub));
  }
  // 代表的な小分類
  assert.equal(classify({ hp: 300, phy: 100, int: 40, agi: 98 }, "damage").sub, "scout");
  assert.equal(classify({ hp: 400, phy: 100, int: 40, agi: 50 }, "damage").sub, "guard");
  assert.equal(classify({ hp: 250, phy: 150, int: 40, agi: 50 }, "damage").sub, "striker");
  assert.equal(classify({ hp: 250, phy: 100, int: 80, agi: 60 }, "buff").sub, "commander");
  assert.equal(classify({ hp: 250, phy: 100, int: 80, agi: 80 }, "damage").sub, "vanguard");
  assert.equal(classify({ hp: 250, phy: 60, int: 80, agi: 150 }, "heal").sub, "support");
  assert.equal(classify({ hp: 250, phy: 60, int: 80, agi: 150 }, "buff").sub, "gunner");
  assert.equal(classify({ hp: 250, phy: 60, int: 150, agi: 80 }, "heal").sub, "healer");
  assert.equal(classify({ hp: 250, phy: 60, int: 150, agi: 80 }, "damage").sub, "caster");
  assert.equal(classify({ hp: 250, phy: 60, int: 150, agi: 120 }, "buff").sub, "sniper");
  assert.equal(classify({ hp: 250, phy: 60, int: 150, agi: 50 }, "buff").sub, "caster");
});

test("skillKindOf: 語の優先は damage > heal > debuff > buff", () => {
  assert.equal(skillKindOf("先頭の敵にPHYの50%ダメージ"), "damage");
  assert.equal(skillKindOf("味方全体のHPを20%回復"), "heal");
  assert.equal(skillKindOf("敵全体のPHYを20%ダウン"), "debuff");
  assert.equal(skillKindOf("敵のAGIを10減少"), "debuff");
  assert.equal(skillKindOf("自身のINTを30%アップ"), "buff");
  assert.equal(skillKindOf("味方のHPが増加"), "buff");
  assert.equal(skillKindOf("ダメージを与えて自身を回復"), "damage");
  assert.equal(skillKindOf("回復しつつ敵のPHYをダウン"), "heal");
  assert.equal(skillKindOf("敵のAGIをダウンし味方のPHYをアップ"), "debuff");
  assert.equal(skillKindOf("自身にバリアを付与"), "buff");
  assert.equal(skillKindOf("最後尾の敵に恐怖を付与"), "debuff");
  assert.equal(skillKindOf(""), "buff");
});

test("toneOf: 代表の属性と、どれにも当たらないときの plain", () => {
  assert.equal(toneOf(["戦国", "長柄武器"]), "bushi");
  assert.equal(toneOf(["三国志", "蜀"]), "bushi");
  assert.equal(toneOf(["指導者", "政治"]), "noble");
  assert.equal(toneOf(["文系学問", "イギリス"]), "scholar");
  assert.equal(toneOf(["理系学問"]), "scholar");
  assert.equal(toneOf(["海", "銃火器"]), "rogue");
  assert.equal(toneOf(["隠密"]), "rogue");
  assert.equal(toneOf(["動物", "日本"]), "plain");
  assert.equal(toneOf([]), "plain");
  // 多いほうが勝つ
  assert.equal(toneOf(["戦国", "長柄武器", "指導者"]), "bushi");
  assert.equal(toneOf(["戦国", "指導者", "政治"]), "noble");
});

// ---------- 生成物（data/heroes.json） ----------

test("data/heroes.json: 契約 §1.4 の形で、params / cls / skill.kind / tone が関数の結果と一致", () => {
  assert.ok(heroList.length >= 150, `heroes ${heroList.length}`);
  const ids = new Set();
  for (const h of heroList) {
    assert.ok(Number.isInteger(h.id) && !ids.has(h.id));
    ids.add(h.id);
    assert.equal(typeof h.name, "string");
    assert.equal(h.image, `Image/Heroes/${h.id}.png`);
    assert.ok(imageExists(h.image), `image ${h.image}`);
    assert.ok(h.rarity >= 1 && h.rarity <= 5);
    assert.ok(h.faction >= 1 && h.faction <= 5);
    assert.ok(Array.isArray(h.attributes));
    assert.deepEqual(h.params, toParams(h.stats));
    assert.deepEqual(h.cls, classify(h.stats, h.skill.kind, h.attributes));
    assert.ok(ALL_SUBS.includes(h.cls.sub));
    assert.ok(["damage", "heal", "buff", "debuff"].includes(h.skill.kind));
    assert.equal(h.skill.kind, skillKindOf(h.skill.text));
    assert.equal(typeof h.skill.name, "string");
    assert.ok(TONES.includes(h.tone));
    assert.equal(h.tone, toneOf(h.attributes, h.faction));
  }
});

test("data/heroes.json: 小分類 10 種がそれぞれ 5 体以上、口調 5 種がそれぞれ 20 体以上", () => {
  const sub = {};
  const tone = {};
  for (const h of heroList) {
    sub[h.cls.sub] = (sub[h.cls.sub] || 0) + 1;
    tone[h.tone] = (tone[h.tone] || 0) + 1;
  }
  for (const s of ALL_SUBS) assert.ok((sub[s] || 0) >= 5, `${s}: ${sub[s] || 0}`);
  for (const t of TONES) assert.ok((tone[t] || 0) >= 20, `${t}: ${tone[t] || 0}`);
});

test("data/enemies.json: 契約 §1.5 の形で画像が実在する", () => {
  const enemies = JSON.parse(fs.readFileSync(new URL("../data/enemies.json", import.meta.url), "utf8"));
  assert.ok(enemies.length >= 100);
  for (const e of enemies) {
    assert.ok(Number.isInteger(e.id));
    assert.equal(typeof e.name, "string");
    assert.match(e.image, /^Image\/Enemies\/[^/]+\.png$/);
    assert.ok(imageExists(e.image), `image ${e.image}`);
    assert.ok(Number.isInteger(e.power) && e.power > 0);
  }
  const ex = enemies.find((e) => e.id === 310);
  assert.deepEqual(ex, { id: 310, name: "クリーパー ショート", image: "Image/Enemies/101.png", power: 20 });
});

test("data/extensions.json: 12 種、契約 §1.6 のキーだけ、画像が実在する", () => {
  assert.equal(extList.length, 12);
  const allowed = new Set(["act", "lead", "str", "int", "gov", "pol", "troopCap", "vision"]);
  const ids = new Set();
  for (const e of extList) {
    assert.ok(!ids.has(e.id));
    ids.add(e.id);
    assert.match(e.image, /^Image\/Extensions\/\d+\.png$/);
    assert.ok(imageExists(e.image), `image ${e.image}`);
    for (const k of Object.keys(e.effect)) assert.ok(allowed.has(k), `effect key ${k}`);
    assert.equal(typeof e.text, "string");
    assert.equal(typeof e.name, "string");
  }
});

// ---------- 装備込みの値・係数・射程 ----------

test("effectiveParams / troopCap / visionOf: 装備の加算", () => {
  const hero = { params: { act: 10, lead: 40, str: 5, int: 20, gov: 15, pol: 12 }, cls: { main: "front", sub: "scout" } };
  const d = {
    extensions: {
      ext_a: { id: "ext_a", effect: { act: 1, lead: 3 } },
      ext_b: { id: "ext_b", effect: { troopCap: 50, vision: 1 } },
    },
  };
  assert.deepEqual(effectiveParams(hero, { equip: null }, d), hero.params);
  assert.deepEqual(effectiveParams(hero, { equip: "ext_a" }, d), { act: 11, lead: 43, str: 5, int: 20, gov: 15, pol: 12 });
  assert.equal(troopCap(hero, { equip: null }, d), 400);
  assert.equal(troopCap(hero, { equip: "ext_a" }, d), 430);
  assert.equal(troopCap(hero, { equip: "ext_b" }, d), 450);
  assert.equal(visionOf(hero, { equip: null }, d), 3);
  assert.equal(visionOf(hero, { equip: "ext_b" }, d), 4);
  assert.equal(visionOf({ ...hero, cls: { main: "mid", sub: "gunner" } }, { equip: null }, d), 2);
  assert.equal(visionOf(hero, null, d), 3, "squad が無くても落ちない");
});

test("rangeOf: front 1 / mid 2 / back 3。caster・support・healer は 2", () => {
  assert.equal(rangeOf({ cls: { main: "front", sub: "striker" } }), 1);
  assert.equal(rangeOf({ cls: { main: "mid", sub: "gunner" } }), 2);
  assert.equal(rangeOf({ cls: { main: "back", sub: "sniper" } }), 3);
  assert.equal(rangeOf({ cls: { main: "back", sub: "caster" } }), 2);
  assert.equal(rangeOf({ cls: { main: "back", sub: "healer" } }), 2);
  assert.equal(rangeOf({ cls: { main: "mid", sub: "support" } }), 2);
});

test("subMods: spec §5.2 の係数", () => {
  assert.deepEqual(subMods("vanguard"), { atk: 1, def: 1, actDelta: 1, skillMult: 1, healAdj: 0 });
  assert.deepEqual(subMods("striker"), { atk: 1.2, def: 1, actDelta: -1, skillMult: 1, healAdj: 0 });
  assert.deepEqual(subMods("guard"), { atk: 1, def: 1.3, actDelta: -1, skillMult: 1, healAdj: 0 });
  assert.deepEqual(subMods("scout"), { atk: 0.8, def: 0.8, actDelta: 1, skillMult: 1, healAdj: 0 });
  assert.deepEqual(subMods("support"), { atk: 1, def: 1, actDelta: -1, skillMult: 1, healAdj: 0.05 });
  assert.deepEqual(subMods("sniper"), { atk: 0.9, def: 1, actDelta: 0, skillMult: 1, healAdj: 0 });
  assert.deepEqual(subMods("caster"), { atk: 1, def: 1, actDelta: -1, skillMult: 1.5, healAdj: 0 });
  assert.deepEqual(subMods("healer"), { atk: 0.7, def: 0.7, actDelta: 0, skillMult: 1, healAdj: 0.1 });
  assert.deepEqual(subMods("unknown"), { atk: 1, def: 1, actDelta: 0, skillMult: 1, healAdj: 0 });
  const m = subMods("striker");
  m.atk = 99;
  assert.equal(subMods("striker").atk, 1.2, "返した物を書き換えても表は変わらない");
});

// ---------- starterHeroes ----------

test("starterHeroes: 9 ランドぶん重ならず、front/mid/back を 1 体ずつ、Common〜Uncommon", () => {
  const rng = makeRng(2024);
  const used = new Set();
  const all = [];
  for (let i = 0; i < 9; i++) {
    const ids = starterHeroes(rng, db, i, used);
    assert.equal(ids.length, 3);
    assert.deepEqual(ids.map((id) => db.heroes[id].cls.main), ["front", "mid", "back"]);
    for (const id of ids) assert.ok(db.heroes[id].rarity <= 2, `rarity of ${id}`);
    all.push(...ids);
  }
  assert.equal(new Set(all).size, 27);
  assert.equal(used.size, 27);
  // 同じ seed なら同じ結果
  assert.deepEqual(starterHeroes(makeRng(5), db, 0, new Set()), starterHeroes(makeRng(5), db, 0, new Set()));
});
