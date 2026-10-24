// SOUL（砦の報酬で仲間になるヒーロー）とエクステンションの獲得・装備。
// DOM に触れない純粋関数。state を書き換えるのは契約で「mutates」と書いたものだけ。
// 契約: docs/specs/SPEC-110-engine-contract.md §3 souls.js。

import { makeRng, pick, shuffle, hashStr } from "./rng.js";
import { startTroops } from "./tuning.js";
import { MORALE_START } from "./morale.js";

function heroListOf(db) {
  if (db.heroList) return db.heroList;
  return Object.values(db.heroes || {});
}

/**
 * SOUL から出る 3 体の候補。
 * soul.role の大分類・soul.rarity から引く。1 枠ごとに 10% で 1 段上のレアリティ（Legendary は上がらない）。
 * そのレアリティに未使用のヒーローが居なければ、隣のレアリティ（+1 → −1 → +2 → −2 …）で埋める。
 * それでも居なければ最後に大分類を無視して埋める。候補どうしは重ならない。
 * @param {() => number} rng
 * @param {object} db
 * @param {{role:"front"|"mid"|"back", rarity:3|4|5, from:string}} soul
 * @param {Set<number>|number[]} usedHeroIds すでに誰かの部隊になっている heroId
 * @returns {number[]} heroId（最大 3。プールが尽きれば少なくなる）
 */
export function candidates(rng, db, soul, usedHeroIds) {
  const taken = new Set(usedHeroIds || []);
  const all = heroListOf(db);
  const ofRole = all.filter((h) => h.cls && h.cls.main === soul.role);

  const drawAt = (list, rarity) => {
    for (const d of [0, 1, -1, 2, -2, 3, -3, 4, -4]) {
      const r = rarity + d;
      if (r < 1 || r > 5) continue;
      const pool = list.filter((h) => h.rarity === r && !taken.has(h.id));
      if (pool.length) return pick(rng, pool);
    }
    return null;
  };

  const out = [];
  for (let i = 0; i < 3; i++) {
    let rarity = soul.rarity;
    if (rarity < 5 && rng() < 0.1) rarity += 1;
    const hero = drawAt(ofRole, rarity) || drawAt(all, rarity);
    if (!hero) break;
    taken.add(hero.id);
    out.push(hero.id);
  }
  return out;
}

function removePending(state, pending) {
  if (!state.pending) return;
  let i = state.pending.indexOf(pending);
  if (i < 0) {
    i = state.pending.findIndex(
      (p) =>
        p.kind === pending.kind &&
        p.land === pending.land &&
        ((p.kind === "soul" && p.soul && pending.soul && p.soul.from === pending.soul.from) ||
          (p.kind === "extension" && p.fort === pending.fort))
    );
  }
  if (i >= 0) state.pending.splice(i, 1);
}

/**
 * SOUL を使ってヒーローを仲間にする（mutates）。
 * 本拠地に部隊を作る。兵は lead × k（tuning.js の START_TROOPS_PER_LEAD）、士気 60。`state.pending` と `land.souls` からその SOUL を外す。
 * @param {object} state
 * @param {object} db
 * @param {string} landId
 * @param {{kind:"soul", land:string, soul:object, candidates:number[]}} pending
 * @param {number} heroId
 * @returns {object} 作った Squad
 */
export function accept(state, db, landId, pending, heroId) {
  const land = state.lands[landId];
  const hero = db.heroes[heroId];
  if (!land) throw new Error(`unknown land: ${landId}`);
  if (!hero) throw new Error(`unknown hero: ${heroId}`);

  const id = "s" + state.nextId++;
  const squad = {
    id,
    heroId: hero.id,
    land: landId,
    tile: land.home,
    troops: startTroops(hero.params.lead),
    ap: 0,
    orders: [],
    policy: "ask",
    status: "ok",
    equip: null,
    ambushed: false,
    morale: MORALE_START,
  };
  state.squads[id] = squad;

  removePending(state, pending);
  if (land.souls && pending && pending.soul) {
    const s = pending.soul;
    let i = land.souls.indexOf(s);
    if (i < 0) i = land.souls.findIndex((x) => x.from === s.from && x.role === s.role && x.rarity === s.rarity);
    if (i >= 0) land.souls.splice(i, 1);
  }
  return squad;
}

/**
 * スワイプに出す 8 枚。そのランドがまだ持っていないものを先に、足りなければ持っているものも混ぜる。
 * @param {() => number} rng
 * @param {object} db
 * @param {{extensions:string[]}} land
 * @returns {string[]} extId（db に 8 種未満しか無ければその数）
 */
export function extensionCandidates(rng, db, land) {
  const ids = shuffle(rng, Object.keys(db.extensions || {}));
  const owned = new Set((land && land.extensions) || []);
  const fresh = ids.filter((id) => !owned.has(id));
  const rest = ids.filter((id) => owned.has(id));
  return fresh.concat(rest).slice(0, 8);
}

/**
 * スワイプの結果からエクステンションを 1 つ手に入れる（mutates）。
 * liked（候補に含まれるものだけ数える）からランダム。空なら candidates からランダム。
 * 契約の引数に rng が無いので、乱数は state（seed・day・nextId）と pending.fort から作る
 * （Math.random は使わない。同じ状況なら同じ結果）。
 * @param {object} state
 * @param {object} db
 * @param {string} landId
 * @param {{kind:"extension", land:string, fort:string, candidates:string[]}} pending
 * @param {string[]} liked
 * @returns {string} 手に入れた extId
 */
export function acceptExtension(state, db, landId, pending, liked) {
  const land = state.lands[landId];
  if (!land) throw new Error(`unknown land: ${landId}`);
  const cands = (pending.candidates || []).filter((id) => db.extensions && db.extensions[id]);
  const ok = (liked || []).filter((id) => cands.includes(id));
  const pool = ok.length ? ok : cands;
  if (!pool.length) throw new Error("no extension candidates");

  const rng = makeRng(hashStr(`${state.seed}:${state.day}:${state.nextId}:${pending.fort}:${landId}`));
  const extId = pick(rng, pool);
  if (!land.extensions) land.extensions = [];
  land.extensions.push(extId);
  removePending(state, pending);
  return extId;
}

/**
 * 装備の付け替え（mutates）。extId が null なら外すだけ。
 * 外したものは `land.extensions` へ戻る。付けるものは `land.extensions` に無ければ何もしない。
 * @param {object} state
 * @param {object} db
 * @param {string} squadId
 * @param {string|null} extId
 * @returns {boolean} 付け替えたら true
 */
export function equip(state, db, squadId, extId) {
  const squad = state.squads[squadId];
  if (!squad) return false;
  const land = state.lands[squad.land];
  if (!land) return false;
  if (!land.extensions) land.extensions = [];
  if (extId == null) extId = null;
  if (extId === squad.equip) return true;

  if (extId !== null) {
    if (!db.extensions || !db.extensions[extId]) return false;
    const i = land.extensions.indexOf(extId);
    if (i < 0) return false;
    land.extensions.splice(i, 1);
  }
  if (squad.equip != null) land.extensions.push(squad.equip);
  squad.equip = extId;
  return true;
}
