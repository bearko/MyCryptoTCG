#!/usr/bin/env node
// ../mycryptoheroes の JSON から data/heroes.json と data/enemies.json を作る。
//
//   node tools/build-data.mjs --repo ../mycryptoheroes [--keep-replicas]
//
// - ヒーロー：Data/Heroes/heroes.json のうち Image/Heroes/<id>.png（MCH リポジトリ）があり、rarity が 1〜5 のもの。
//   MCH の "replica" / "other"（id 11001〜）は元のヒーローと名前・能力が同じ写しなので、
//   同じ名前が 2 度出ないよう既定では落とす（--keep-replicas で残す）。
//   params / cls / skill.kind / tone は js/engine/heroes.js の関数で導く（ここでは手で書かない）。
// - エネミー：Data/Enemies/enemies.json のうち、image_file_path のファイル名が Image/Enemies/（MCH リポジトリ）にあるもの。
//   power は base_param の hp + phy + int + agi。power が MAX_ENEMY_POWER を超えるもの（イベント用のボスで、
//   体力が数千万〜数億ある）は砦の帯を壊すので落とす。ふつうのエネミーは 3,330 以下で、間に値は無い。
//   名前に他のゲームの名前・実在の人物の名前を含むもの（EXCLUDE_ENEMY_NAME）も落とす（砦の名前に出るため）。
// - エクステンション：data/extensions.json は手書き（生成しない）。ここでは確かめるだけ：
//   image が Image/Extensions/<n>.png の形で MCH リポジトリに実在し、name が Data/Extensions/extensions.json の
//   同じ id の name.ja と一致すること。食い違いがあれば終了コード 1。
// 人の本名は書かない（ヒーロー名は MCH の名前をそのまま使う）。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toParams, classify, skillKindOf, toneOf } from "../js/engine/heroes.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

function parseArgs(argv) {
  const opt = { repo: path.resolve(root, "../mycryptoheroes"), keepReplicas: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") opt.repo = path.resolve(argv[++i]);
    else if (a === "--keep-replicas") opt.keepReplicas = true;
    else if (a === "-h" || a === "--help") {
      console.log("usage: node tools/build-data.mjs [--repo <mycryptoheroes の clone>] [--keep-replicas]");
      process.exit(0);
    } else throw new Error(`unknown argument: ${a}`);
  }
  return opt;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n");
}

/** 説明文の {triggerRate} / {successRate} を数字に置き換える */
function skillText(desc) {
  const ja = desc && desc.ja;
  if (!ja) return "";
  let text = ja.text || "";
  if (typeof ja.trigger_rate === "number") text = text.replaceAll("{triggerRate}", String(ja.trigger_rate));
  const eff = Array.isArray(ja.effects) ? ja.effects : [];
  let k = 0;
  text = text.replace(/\{successRate\}/g, () => {
    const e = eff[k++] || eff[eff.length - 1];
    return e && typeof e.success_rate === "number" ? String(e.success_rate) : "{successRate}";
  });
  return text;
}

function buildHeroes(repo, keepReplicas) {
  const src = readJson(path.join(repo, "Data", "Heroes", "heroes.json"));
  const imgDir = path.join(repo, "Image", "Heroes");
  const seenNames = new Set();
  const out = [];
  const skipped = { noImage: 0, noRarity: 0, replica: 0 };

  for (const h of [...src].sort((a, b) => a.id - b.id)) {
    const file = `${h.id}.png`;
    if (!fs.existsSync(path.join(imgDir, file))) {
      skipped.noImage++;
      continue;
    }
    const rarity = h.rarity && h.rarity.id;
    if (!(rarity >= 1 && rarity <= 5)) {
      skipped.noRarity++;
      continue;
    }
    const name = h.name.ja;
    if (!keepReplicas && seenNames.has(name)) {
      skipped.replica++;
      continue;
    }
    seenNames.add(name);

    const stats = {
      hp: h.max_level_stats.hp,
      phy: h.max_level_stats.phy,
      int: h.max_level_stats.int,
      agi: h.max_level_stats.agi,
    };
    const attributes = (h.attributes || []).map((a) => a.name.ja).filter(Boolean);
    const text = skillText(h.passive && h.passive.description);
    const kind = skillKindOf(text);
    const faction = h.faction && h.faction.id;

    out.push({
      id: h.id,
      name,
      nameEn: h.name.en,
      image: `Image/Heroes/${file}`,
      rarity,
      faction,
      attributes,
      stats,
      params: toParams(stats),
      cls: classify(stats, kind, attributes),
      skill: { name: (h.passive && h.passive.name && h.passive.name.ja) || "", kind, text },
      tone: toneOf(attributes, faction),
    });
  }
  return { heroes: out, skipped };
}

const MAX_ENEMY_POWER = 10000;
const EXCLUDE_ENEMY_NAME = /ETHEREMON|サトシ・ナカモト/i;

function buildEnemies(repo) {
  const src = readJson(path.join(repo, "Data", "Enemies", "enemies.json"));
  const imgDir = path.join(repo, "Image", "Enemies");
  const files = new Set(fs.readdirSync(imgDir));
  const out = [];
  for (const e of [...src].sort((a, b) => a.id - b.id)) {
    const file = e.image_file_path ? path.basename(e.image_file_path) : null;
    if (!file || !files.has(file)) continue;
    if (EXCLUDE_ENEMY_NAME.test(e.name.ja || "")) continue;
    const b = e.base_param || {};
    const power = (b.hp || 0) + (b.phy || 0) + (b.int || 0) + (b.agi || 0);
    if (power > MAX_ENEMY_POWER) continue;
    out.push({ id: e.id, name: e.name.ja, image: `Image/Enemies/${file}`, power });
  }
  return out;
}

/** 手書きの data/extensions.json を MCH のマスターと突き合わせる。問題の一覧を返す */
function checkExtensions(repo) {
  const mine = readJson(path.join(root, "data", "extensions.json"));
  const src = readJson(path.join(repo, "Data", "Extensions", "extensions.json"));
  const byId = new Map(src.map((e) => [e.id, e]));
  const problems = [];
  for (const x of mine) {
    const m = /^Image\/Extensions\/(\d+)\.png$/.exec(x.image || "");
    if (!m) {
      problems.push(`${x.id}: image の形が違う（${x.image}）`);
      continue;
    }
    if (!fs.existsSync(path.join(repo, x.image))) problems.push(`${x.id}: 画像が無い（${x.image}）`);
    const e = byId.get(Number(m[1]));
    if (!e) problems.push(`${x.id}: MCH に id ${m[1]} のエクステンションが無い`);
    else if (e.name.ja !== x.name) problems.push(`${x.id}: 名前が違う（${x.name} / MCH は ${e.name.ja}）`);
  }
  return { count: mine.length, problems };
}

function tally(list, key) {
  const c = {};
  for (const x of list) {
    const k = key(x);
    c[k] = (c[k] || 0) + 1;
  }
  return c;
}

function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(path.join(opt.repo, "Data", "Heroes", "heroes.json"))) {
    console.error(`mycryptoheroes の clone が見つかりません: ${opt.repo}（--repo で場所を指定）`);
    process.exit(1);
  }

  const { heroes, skipped } = buildHeroes(opt.repo, opt.keepReplicas);
  const enemies = buildEnemies(opt.repo);

  writeJson(path.join(root, "data", "heroes.json"), heroes);
  writeJson(path.join(root, "data", "enemies.json"), enemies);

  console.log(`heroes: ${heroes.length} 体（画像なし ${skipped.noImage} / rarity なし ${skipped.noRarity} / 写し ${skipped.replica} を除外）`);
  console.log("  rarity:", tally(heroes, (h) => h.rarity));
  console.log("  main:  ", tally(heroes, (h) => h.cls.main));
  console.log("  sub:   ", tally(heroes, (h) => h.cls.sub));
  console.log("  skill: ", tally(heroes, (h) => h.skill.kind));
  console.log("  tone:  ", tally(heroes, (h) => h.tone));
  const pw = enemies.map((e) => e.power).sort((a, b) => a - b);
  console.log(`enemies: ${enemies.length} 体（power ${pw[0]}〜${pw[pw.length - 1]}、中央値 ${pw[pw.length >> 1]}）`);

  const ext = checkExtensions(opt.repo);
  if (ext.problems.length) {
    console.error(`extensions: ${ext.count} 種のうち ${ext.problems.length} 件に問題`);
    for (const p of ext.problems) console.error("  " + p);
    process.exitCode = 1;
  } else {
    console.log(`extensions: ${ext.count} 種（画像・名前とも MCH と一致）`);
  }
}

main();
