// 戦闘の解決（部隊 × 部隊 / 部隊 × 砦 / 部隊 × 本拠地）。
// DOM に触れない純粋関数。乱数は引数の rng だけを使う。state を書き換えるのは resolve だけ（契約で mutates）。
// 契約: docs/specs/SPEC-110-engine-contract.md §3 battle.js。式は docs/specs/SPEC-109-mycryptowars-mvp.md §7.2。

import { distance, neighbors } from "./hex.js";
import { effectiveParams, subMods, visionOf, rangeOf, troopCap } from "./heroes.js";
import { candidates, accept, extensionCandidates, acceptExtension } from "./souls.js";
import { pick } from "./rng.js";

/** エネミー（砦の持ち主）の特別なランド id */
export const ENEMY_LAND = "enemy";

/** 砦のランクごとの統率力相当 */
export const FORT_LEAD = { rare: 20, epic: 35, legendary: 60 };

/** 砦のランク → SOUL のレアリティ */
const SOUL_RARITY = { rare: 3, epic: 4, legendary: 5 };

/** 本拠地の耐久（lands[landId].homeDurability が無ければこの値から） */
export const HOME_MAX_DURABILITY = 100;

/** 本拠地（立っている部隊がいないとき）の統率力相当。def だけに使う */
export const HOME_LEAD = 40;

/** 守る側の地形で def ×1.2 になる地形 */
const DEFENSIVE_TERRAIN = new Set(["mountain", "volcano", "river"]);

/** 視界：砦 2 / 本拠地 3 */
const FORT_VISION = 2;
const HOME_VISION = 3;

/** 砦の守備方針の係数 */
const INTERCEPT_COUNTER = 1.3;
const DEFEND_DURABILITY = 0.6;

function heroOf(db, squad) {
  const hero = db.heroes[squad.heroId];
  if (!hero) throw new Error(`unknown hero: ${squad.heroId}`);
  return hero;
}

function dims(state) {
  return { w: state.map.w, h: state.map.h };
}

function terrainAt(state, tile) {
  const t = state.map.tiles[tile];
  return t ? t.terrain : null;
}

/** 戦える（敗走していない・兵がいる）部隊か */
function isActive(squad) {
  return squad && squad.status !== "routed" && squad.troops > 0;
}

/** そのランドの指揮（commander）が隣接していれば true（自分自身は数えない） */
function hasAdjacentCommander(state, db, squad) {
  const { w, h } = dims(state);
  const near = new Set(neighbors(squad.tile, w, h));
  for (const other of Object.values(state.squads)) {
    if (other.id === squad.id || other.land !== squad.land || !isActive(other)) continue;
    if (!near.has(other.tile)) continue;
    const hero = db.heroes[other.heroId];
    if (hero && hero.cls && hero.cls.sub === "commander") return true;
  }
  return false;
}

/**
 * 部隊の攻防力。atk = lead × (1 + 兵 / 100) × 小分類の係数、def も同じ形。
 * def は守る側として使う値なので、立っている地形（mountain / volcano / river）で ×1.2。
 * 隣接する味方に指揮（commander）がいれば atk・def とも ×1.1。
 * @returns {{atk:number, def:number}}
 */
export function power(state, db, squad) {
  const hero = heroOf(db, squad);
  const p = effectiveParams(hero, squad, db);
  const mods = subMods(hero.cls && hero.cls.sub);
  const base = p.lead * (1 + Math.max(0, squad.troops) / 100);
  let atk = base * mods.atk;
  let def = base * mods.def;
  if (DEFENSIVE_TERRAIN.has(terrainAt(state, squad.tile))) def *= 1.2;
  if (hasAdjacentCommander(state, db, squad)) {
    atk *= 1.1;
    def *= 1.1;
  }
  return { atk, def };
}

/**
 * 砦の攻防力。lead はランド相当（rare 20 / epic 35 / legendary 60）。
 * atk = lead × (1 + 守備兵 / 100)、def = lead × (1 + 耐久 / 最大耐久)。
 * @returns {{atk:number, def:number}}
 */
export function fortPower(state, db, fort) {
  void state;
  void db;
  const lead = FORT_LEAD[fort.rank] || FORT_LEAD.rare;
  const atk = lead * (1 + Math.max(0, fort.troops) / 100);
  const max = fort.maxDurability > 0 ? fort.maxDurability : 1;
  const def = lead * (1 + Math.max(0, fort.durability) / max);
  return { atk, def };
}

function homeDurabilityOf(land) {
  return typeof land.homeDurability === "number" ? land.homeDurability : HOME_MAX_DURABILITY;
}

/** 本拠地（部隊がいないとき）の防御力。HOME_LEAD × (1 + 耐久 / 100) */
export function homePower(state, landId) {
  const land = state.lands[landId];
  const dur = land ? homeDurabilityOf(land) : 0;
  return { atk: 0, def: HOME_LEAD * (1 + Math.max(0, dur) / HOME_MAX_DURABILITY) };
}

/** そのランドの部隊の視界に tile が入っているか */
function seenBySquads(state, db, landId, tile) {
  const { w, h } = dims(state);
  for (const s of Object.values(state.squads)) {
    if (s.land !== landId || s.status === "routed") continue;
    const hero = db.heroes[s.heroId];
    if (!hero) continue;
    if (distance(s.tile, tile, w, h) <= visionOf(hero, s, db)) return true;
  }
  return false;
}

function isFort(target) {
  return target && typeof target.rank === "string" && typeof target.durability === "number";
}

function isHome(target) {
  return target && typeof target.home === "string" && target.heroId === undefined;
}

/**
 * 奇襲か（防御側の視界に攻撃側がいなければ true）。
 * 部隊：同じランドの全部隊（敗走中を除く）の視界。砦：砦のタイルから 2（持ち主がランドならその部隊の視界も）。
 * 本拠地 `{ home: landId }`：本拠地から 3 とそのランドの部隊の視界。
 */
export function isAmbush(state, db, attacker, defender) {
  const { w, h } = dims(state);
  const at = attacker.tile;
  if (isHome(defender)) {
    const land = state.lands[defender.home];
    if (land && distance(land.home, at, w, h) <= HOME_VISION) return false;
    return !seenBySquads(state, db, defender.home, at);
  }
  if (isFort(defender)) {
    if (distance(defender.tile, at, w, h) <= FORT_VISION) return false;
    if (defender.owner !== ENEMY_LAND && seenBySquads(state, db, defender.owner, at)) return false;
    return true;
  }
  return !seenBySquads(state, db, defender.land, at);
}

/**
 * 射程内か。hex.distance ≤ heroes.rangeOf(hero)。
 * squad は tile と heroId を持っていればよい（orders.js は予定位置の写しを渡す）。
 */
export function inRange(state, db, squad, targetTile) {
  const hero = heroOf(db, squad);
  const { w, h } = dims(state);
  return distance(squad.tile, targetTile, w, h) <= rangeOf(hero);
}

/**
 * 1 回の打撃（回避 → スキル → ダメージ）。兵は引かない（呼ぶ側が引く）。
 * @param {object} a 攻め手 { kind:"squad"|"fort", squad?, fort?, power }
 * @param {object} d 受け手 { kind:"squad"|"fort"|"home", squad?, power }
 * @returns {{evaded:boolean, dmg:number, skill:null|{name,kind,value}}}
 */
function strike(state, db, rng, a, d, ambush, atkMult = 1) {
  // 回避：受け手が部隊のときだけ（奇襲なら 0）。砦・本拠地は 0
  if (!ambush && d.kind === "squad") {
    const dp = effectiveParams(heroOf(db, d.squad), d.squad, db);
    if (rng() * 100 < dp.int) return { evaded: true, dmg: 0, skill: null };
  }
  let atk = a.power.atk * atkMult;
  let def = d.power.def;
  let skill = null;
  let extra = 0;
  if (a.kind === "squad") {
    const hero = heroOf(db, a.squad);
    const ap = effectiveParams(hero, a.squad, db);
    const mods = subMods(hero.cls && hero.cls.sub);
    if (hero.skill && rng() * 100 < ap.int) {
      const kind = hero.skill.kind;
      if (kind === "damage") {
        extra = Math.round(ap.str * 3 * mods.skillMult);
        skill = { name: hero.skill.name, kind, value: extra };
      } else if (kind === "heal") {
        const cap = troopCap(hero, a.squad, db);
        const before = a.squad.troops;
        a.squad.troops = Math.min(cap, before + Math.round(ap.str * 3));
        if (a.squad.troops < before) a.squad.troops = before; // 上限を超えていた分は削らない
        skill = { name: hero.skill.name, kind, value: a.squad.troops - before };
      } else if (kind === "buff") {
        atk *= 1.2;
        skill = { name: hero.skill.name, kind, value: 20 };
      } else if (kind === "debuff") {
        def *= 0.8;
        skill = { name: hero.skill.name, kind, value: 20 };
      }
    }
  }
  const dmg = Math.max(1, Math.round(atk * 0.5 - def * 0.25)) + extra;
  return { evaded: false, dmg, skill };
}

/** 敗走（mutates）。routed イベントを返す */
function rout(state, squad) {
  const land = state.lands[squad.land];
  squad.troops = 0;
  squad.status = "routed";
  squad.orders = [];
  if (land) squad.tile = land.home;
  return { t: "routed", squad: squad.id, home: squad.tile };
}

/** 部隊に dmg を与える（mutates）。溢れた分（兵を超えた分）を返す */
function damageSquad(state, squad, dmg, followups) {
  const overflow = Math.max(0, dmg - squad.troops);
  squad.troops -= dmg;
  if (squad.troops <= 0) followups.push(rout(state, squad));
  return overflow;
}

function usedHeroIds(state) {
  return new Set(Object.values(state.squads).map((s) => s.heroId));
}

/** 砦の陥落（mutates）。followups にイベントを積む */
function fallFort(state, db, rng, fort, byLand, followups) {
  const from = fort.owner;
  fort.owner = byLand;
  fort.troops = 30;
  fort.durability = Math.floor(fort.maxDurability / 2);
  const tile = state.map.tiles[fort.tile];
  if (tile) tile.owner = byLand;
  followups.push({ t: "fort_fallen", fort: fort.id, by: byLand, from });

  if (from === ENEMY_LAND) {
    const land = state.lands[byLand];
    const soul = { role: pick(rng, ["front", "mid", "back"]), rarity: SOUL_RARITY[fort.rank] || 3, from: fort.id };
    if (land) {
      if (!land.souls) land.souls = [];
      land.souls.push(soul);
    }
    followups.push({ t: "soul", land: byLand, soul });
    followups.push({ t: "extension_offer", land: byLand, fort: fort.id });

    const soulPending = { kind: "soul", land: byLand, soul, candidates: candidates(rng, db, soul, usedHeroIds(state)) };
    const extPending = { kind: "extension", land: byLand, fort: fort.id, candidates: extensionCandidates(rng, db, land) };
    if (byLand === state.playerLand) {
      if (!state.pending) state.pending = [];
      state.pending.push(soulPending, extPending);
    } else if (land) {
      // CPU のランドは選択を待たず、その場で受け取る（SOUL は候補の先頭、エクステンションはおまかせ）
      if (soulPending.candidates.length) accept(state, db, byLand, soulPending, soulPending.candidates[0]);
      if (extPending.candidates.length) acceptExtension(state, db, byLand, extPending, []);
    }
    if (fort.rank === "legendary") followups.push({ t: "clear", land: byLand });
  }
}

/** 本拠地の陥落（mutates） */
function fallHome(state, landId, byLand, followups) {
  const land = state.lands[landId];
  const by = state.lands[byLand];
  land.alive = false;
  land.homeDurability = 0;
  const heroes = [];
  for (const s of Object.values(state.squads)) {
    if (s.land !== landId) continue;
    s.land = byLand;
    if (by) s.tile = by.home;
    s.orders = [];
    heroes.push(s.id);
  }
  for (const f of Object.values(state.forts)) {
    if (f.owner !== landId) continue;
    f.owner = byLand;
  }
  // 脱落したランドの占領地（本拠地・砦のタイルを含む）は攻めたランドのものに
  for (const t of state.map.tiles) if (t && t.owner === landId) t.owner = byLand;
  followups.push({ t: "home_fallen", land: landId, by: byLand, heroes });
}

/** 砦・本拠地を守っている部隊（そのランドの、戦える部隊。兵の多い順で先頭） */
function guardOn(state, landId, tile) {
  let best = null;
  for (const s of Object.values(state.squads)) {
    if (s.land !== landId || s.tile !== tile || !isActive(s)) continue;
    if (!best || s.troops > best.troops) best = s;
  }
  return best;
}

/**
 * 戦闘を 1 回解決する（mutates）。§spec 7.2 の順：回避 → スキル → ダメージ → 反撃。
 * @param {object} state
 * @param {object} db
 * @param {() => number} rng
 * @param {object} attacker Squad
 * @param {object} target Squad | Fort | { home: landId }
 * @returns {object} Event(t:"battle")。陥落・敗走などは event.followups に入る
 */
export function resolve(state, db, rng, attacker, target) {
  const followups = [];
  const ambush = isAmbush(state, db, attacker, target);
  const aSide = { kind: "squad", squad: attacker, power: power(state, db, attacker) };

  let mode; // "squad" | "fort" | "home"
  let fort = null;
  let homeLand = null;
  let defSquad = null;
  let at;
  if (isHome(target)) {
    mode = "home";
    homeLand = target.home;
    at = state.lands[homeLand].home;
    defSquad = guardOn(state, homeLand, at);
  } else if (isFort(target)) {
    mode = "fort";
    fort = target;
    at = fort.tile;
    if (fort.owner !== ENEMY_LAND) defSquad = guardOn(state, fort.owner, at);
  } else {
    mode = "squad";
    defSquad = target;
    at = target.tile;
  }

  let dSide;
  if (defSquad) dSide = { kind: "squad", squad: defSquad, power: power(state, db, defSquad) };
  else if (mode === "fort") dSide = { kind: "fort", fort, power: fortPower(state, db, fort) };
  else dSide = { kind: "home", power: homePower(state, homeLand) };

  const hit = strike(state, db, rng, aSide, dSide, ambush);
  let result = mode === "squad" ? "hit" : "fort_damaged";
  if (mode === "home") result = "home_damaged";

  let overflow = 0;
  if (!hit.evaded) {
    if (defSquad) {
      overflow = damageSquad(state, defSquad, hit.dmg, followups);
      if (defSquad.status === "routed") result = "routed";
      if (ambush) defSquad.ambushed = true;
      if (mode === "squad") overflow = 0; // 部隊どうしでは溢れは捨てる
    } else {
      overflow = hit.dmg;
    }
  }

  // 砦：守備兵 → 耐久 → 陥落。守る部隊からの溢れも砦へ（防衛優先なら耐久ダメージ ×0.6）
  let fallen = false;
  if (mode === "fort" && overflow > 0) {
    const toTroops = Math.min(fort.troops, overflow);
    fort.troops -= toTroops;
    let rest = overflow - toTroops;
    if (rest > 0) {
      if (defSquad && fort.stance !== "intercept") rest = Math.max(1, Math.round(rest * DEFEND_DURABILITY));
      fort.durability = Math.max(0, fort.durability - rest);
    }
    if (fort.durability <= 0 && fort.troops <= 0) {
      fallFort(state, db, rng, fort, attacker.land, followups);
      fallen = true;
      result = "fort_fallen";
    }
  }
  if (mode === "home" && overflow > 0) {
    const land = state.lands[homeLand];
    land.homeDurability = Math.max(0, homeDurabilityOf(land) - overflow);
    if (land.homeDurability <= 0) {
      fallHome(state, homeLand, attacker.land, followups);
      fallen = true;
      result = "home_fallen";
    }
  }

  // 反撃：受けた部隊が残っていて、方針が fight（砦の上で迎撃優先なら方針によらず ×1.3）。
  // 守備部隊のいない砦の守備兵も 1 回反撃する。本拠地（部隊なし）は反撃しない
  let counter = null;
  if (!fallen && isActive(attacker)) {
    let counterSide = null;
    let mult = 1;
    if (defSquad && isActive(defSquad)) {
      const intercept = mode === "fort" && fort.stance === "intercept";
      if (defSquad.policy === "fight" || intercept) {
        counterSide = { kind: "squad", squad: defSquad, power: power(state, db, defSquad) };
        if (intercept) mult = INTERCEPT_COUNTER;
      }
    } else if (!defSquad && mode === "fort" && fort.troops > 0) {
      counterSide = { kind: "fort", fort, power: fortPower(state, db, fort) };
    }
    if (counterSide) {
      const back = { kind: "squad", squad: attacker, power: power(state, db, attacker) };
      const c = strike(state, db, rng, counterSide, back, false, mult);
      counter = { evaded: c.evaded, dmg: c.dmg };
      if (c.skill) counter.skill = c.skill;
      if (!c.evaded) damageSquad(state, attacker, c.dmg, followups);
    }
  }

  let defender;
  if (defSquad) defender = defSquad.id;
  else if (mode === "fort") defender = fort.id;
  else defender = homeLand;

  return {
    t: "battle",
    attacker: attacker.id,
    defender,
    target: mode,
    at,
    ambush,
    evaded: hit.evaded,
    dmg: hit.evaded ? 0 : hit.dmg,
    skill: hit.skill,
    counter,
    result,
    followups,
  };
}
