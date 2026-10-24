// 戦闘の解決（部隊 × 部隊 / 部隊 × 砦 / 部隊 × 本拠地）。
// DOM に触れない純粋関数。乱数は引数の rng だけを使う。state を書き換えるのは resolve だけ（契約で mutates）。
// 契約: docs/specs/SPEC-110-engine-contract.md §3 battle.js。式は docs/specs/SPEC-109-mycryptowars-mvp.md §7.2。
// SPEC-113：攻防に士気係数（砦・本拠地は士気 60 扱い）、戦闘での士気の変化、見込み（predict。rng を使わない）。
//
// resolve と predict は同じ fight() を通る。違うのは「回避・スキルが起きるか」の決め方だけ
// （resolve は rng、predict は起きる / 起きないの組み合わせを全部試す）。だから predict の幅は
// 実際の resolve の結果を必ず含む。

import { distance, neighbors } from "./hex.js";
import { effectiveParams, subMods, visionOf, rangeOf, musterCap } from "./heroes.js";
import { candidates, accept, extensionCandidates, acceptExtension } from "./souls.js";
import { pick } from "./rng.js";
import {
  moraleMult, changeMorale, setMorale, MORALE_DELTA, SKILL_MORALE, STRUCTURE_MORALE,
} from "./morale.js";

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
 * 最後に士気係数（0.75 + 0.005 × 士気）を atk・def に掛ける（SPEC-113 §1）。
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
  const mm = moraleMult(squad.morale);
  return { atk: atk * mm, def: def * mm };
}

/**
 * 砦の攻防力。lead はランド相当（rare 20 / epic 35 / legendary 60）。
 * atk = lead × (1 + 守備兵 / 100)、def = lead × (1 + 耐久 / 最大耐久)。士気 60 扱いの係数を掛ける。
 * @returns {{atk:number, def:number}}
 */
export function fortPower(state, db, fort) {
  void state;
  void db;
  const lead = FORT_LEAD[fort.rank] || FORT_LEAD.rare;
  const mm = moraleMult(STRUCTURE_MORALE);
  const atk = lead * (1 + Math.max(0, fort.troops) / 100) * mm;
  const max = fort.maxDurability > 0 ? fort.maxDurability : 1;
  const def = lead * (1 + Math.max(0, fort.durability) / max) * mm;
  return { atk, def };
}

function homeDurabilityOf(land) {
  return typeof land.homeDurability === "number" ? land.homeDurability : HOME_MAX_DURABILITY;
}

/** 本拠地（部隊がいないとき）の防御力。HOME_LEAD × (1 + 耐久 / 100) × 士気 60 扱いの係数 */
export function homePower(state, landId) {
  const land = state.lands[landId];
  const dur = land ? homeDurabilityOf(land) : 0;
  return { atk: 0, def: HOME_LEAD * (1 + Math.max(0, dur) / HOME_MAX_DURABILITY) * moraleMult(STRUCTURE_MORALE) };
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

/** resolve が使う「回避・スキルが起きるか」：rng() × 100 < 確率（従来どおり、回避 → スキルの順に引く） */
function rngDice(rng) {
  return {
    evade: (p) => rng() * 100 < p,
    skill: (p) => rng() * 100 < p,
  };
}

function pushIf(list, ev) {
  if (ev) list.push(ev);
}

/**
 * 1 回の打撃（回避 → スキル → ダメージ）。兵は引かない（呼ぶ側が引く）。
 * スキルが発動したら士気も動かす（SPEC-113 §1.2。buff・heal は自分の部隊、debuff は相手の部隊）。
 * @param {object} dice { evade(p, side), skill(p, side) } → boolean
 * @param {object} a 攻め手 { kind:"squad"|"fort", squad?, fort?, power }
 * @param {object} d 受け手 { kind:"squad"|"fort"|"home", squad?, power }
 * @param {"hit"|"counter"} side
 * @returns {{evaded:boolean, dmg:number, skill:null|{name,kind,value}}}
 */
function strike(state, db, dice, a, d, ambush, atkMult, side, followups) {
  // 回避：受け手が部隊のときだけ（奇襲なら 0）。砦・本拠地は 0
  if (!ambush && d.kind === "squad") {
    const dp = effectiveParams(heroOf(db, d.squad), d.squad, db);
    if (dice.evade(dp.int, side)) return { evaded: true, dmg: 0, skill: null };
  }
  let atk = a.power.atk * atkMult;
  let def = d.power.def;
  let skill = null;
  let extra = 0;
  if (a.kind === "squad") {
    const hero = heroOf(db, a.squad);
    const ap = effectiveParams(hero, a.squad, db);
    const mods = subMods(hero.cls && hero.cls.sub);
    if (hero.skill && dice.skill(ap.int, side)) {
      const kind = hero.skill.kind;
      if (kind === "damage") {
        extra = Math.round(ap.str * 3 * mods.skillMult);
        skill = { name: hero.skill.name, kind, value: extra };
      } else if (kind === "heal") {
        // 回復スキルも定員まで（SPEC-113 §2.1）
        const cap = musterCap(hero, a.squad, db);
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
      const sm = SKILL_MORALE[kind];
      if (sm && sm.self) pushIf(followups, changeMorale(a.squad, sm.self, "skill"));
      if (sm && sm.foe && d.kind === "squad") pushIf(followups, changeMorale(d.squad, sm.foe, "skill"));
    }
  }
  const dmg = Math.max(1, Math.round(atk * 0.5 - def * 0.25)) + extra;
  return { evaded: false, dmg, skill };
}

/** 敗走（mutates）。routed イベントを返す。士気は 30 にする（morale イベントは followups へ） */
function rout(state, squad, followups) {
  const land = state.lands[squad.land];
  squad.troops = 0;
  squad.status = "routed";
  squad.orders = [];
  if (land) squad.tile = land.home;
  const ev = { t: "routed", squad: squad.id, home: squad.tile };
  followups.push(ev);
  pushIf(followups, setMorale(squad, MORALE_DELTA.routed, "routed"));
  return ev;
}

/** 部隊に dmg を与える（mutates）。溢れた分（兵を超えた分）を返す */
function damageSquad(state, squad, dmg, followups) {
  const overflow = Math.max(0, dmg - squad.troops);
  squad.troops -= dmg;
  if (squad.troops <= 0) rout(state, squad, followups);
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

/** 本拠地の陥落（mutates）。相手に従った部隊は士気 30 */
function fallHome(state, landId, byLand, followups) {
  const land = state.lands[landId];
  const by = state.lands[byLand];
  land.alive = false;
  land.homeDurability = 0;
  const heroes = [];
  const moraleEvents = [];
  for (const s of Object.values(state.squads)) {
    if (s.land !== landId) continue;
    s.land = byLand;
    if (by) s.tile = by.home;
    s.orders = [];
    heroes.push(s.id);
    pushIf(moraleEvents, setMorale(s, MORALE_DELTA.surrender, "surrender"));
  }
  for (const f of Object.values(state.forts)) {
    if (f.owner !== landId) continue;
    f.owner = byLand;
  }
  // 脱落したランドの占領地（本拠地・砦のタイルを含む）は攻めたランドのものに
  for (const t of state.map.tiles) if (t && t.owner === landId) t.owner = byLand;
  followups.push({ t: "home_fallen", land: landId, by: byLand, heroes });
  followups.push(...moraleEvents);
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
 * 戦闘の本体（mutates）。resolve と predict が通る。
 * dry = true のとき（predict の写しの上）は、陥落の後始末（持ち主の変更・SOUL・降伏）をしない。
 * @returns {{ ev: object, info: object }}
 */
function fight(state, db, attacker, target, dice, rng, dry) {
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

  const homeLandObj = homeLand ? state.lands[homeLand] : null;
  const before = {
    attacker: Math.max(0, attacker.troops),
    defender: defSquad ? Math.max(0, defSquad.troops) : 0,
    fortTroops: fort ? Math.max(0, fort.troops) : 0,
    durability: fort ? Math.max(0, fort.durability) : homeLandObj ? homeDurabilityOf(homeLandObj) : 0,
  };

  let dSide;
  if (defSquad) dSide = { kind: "squad", squad: defSquad, power: power(state, db, defSquad) };
  else if (mode === "fort") dSide = { kind: "fort", fort, power: fortPower(state, db, fort) };
  else dSide = { kind: "home", power: homePower(state, homeLand) };

  const hit = strike(state, db, dice, aSide, dSide, ambush, 1, "hit", followups);
  let result = mode === "squad" ? "hit" : "fort_damaged";
  if (mode === "home") result = "home_damaged";

  let overflow = 0;
  if (!hit.evaded) {
    if (defSquad) {
      overflow = damageSquad(state, defSquad, hit.dmg, followups);
      if (defSquad.status === "routed") result = "routed";
      if (ambush) {
        defSquad.ambushed = true;
        if (defSquad.status !== "routed") pushIf(followups, changeMorale(defSquad, MORALE_DELTA.ambushed, "ambushed"));
      }
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
      if (!dry) fallFort(state, db, rng, fort, attacker.land, followups);
      fallen = true;
      result = "fort_fallen";
    }
  }
  if (mode === "home" && overflow > 0) {
    homeLandObj.homeDurability = Math.max(0, homeDurabilityOf(homeLandObj) - overflow);
    if (homeLandObj.homeDurability <= 0) {
      if (!dry) fallHome(state, homeLand, attacker.land, followups);
      fallen = true;
      result = "home_fallen";
    }
  }
  const dealtTroops = (defSquad ? before.defender - Math.max(0, defSquad.troops) : 0) + (fort ? before.fortTroops - Math.max(0, fort.troops) : 0);

  // 反撃：受けた部隊が残っていて、方針が fight（砦の上で迎撃優先なら方針によらず ×1.3）。
  // 守備部隊のいない砦の守備兵も 1 回反撃する。本拠地（部隊なし）は反撃しない
  let counter = null;
  let counterSquad = null;
  if (!fallen && isActive(attacker)) {
    let counterSide = null;
    let mult = 1;
    if (defSquad && isActive(defSquad)) {
      const intercept = mode === "fort" && fort.stance === "intercept";
      if (defSquad.policy === "fight" || intercept) {
        counterSide = { kind: "squad", squad: defSquad, power: power(state, db, defSquad) };
        counterSquad = defSquad;
        if (intercept) mult = INTERCEPT_COUNTER;
      }
    } else if (!defSquad && mode === "fort" && fort.troops > 0) {
      counterSide = { kind: "fort", fort, power: fortPower(state, db, fort) };
    }
    if (counterSide) {
      const back = { kind: "squad", squad: attacker, power: power(state, db, attacker) };
      const c = strike(state, db, dice, counterSide, back, false, mult, "counter", followups);
      counter = { evaded: c.evaded, dmg: c.dmg };
      if (c.skill) counter.skill = c.skill;
      if (!c.evaded) damageSquad(state, attacker, c.dmg, followups);
    }
  }
  const takenTroops = Math.max(0, before.attacker - Math.max(0, attacker.troops));

  // 勝ち負けの士気（SPEC-113 §1.1）。勝ち = 相手を敗走させた・砦 / 本拠地を落とした。負け = 与えたより受けた兵が多い
  const attackerWon = result === "routed" || fallen;
  if (attacker.status !== "routed") {
    if (attackerWon) pushIf(followups, changeMorale(attacker, MORALE_DELTA.win, "win"));
    else if (takenTroops > dealtTroops) pushIf(followups, changeMorale(attacker, MORALE_DELTA.lose, "lose"));
  }
  if (defSquad && defSquad.status !== "routed" && !fallen) {
    if (attacker.status === "routed" && counterSquad === defSquad) pushIf(followups, changeMorale(defSquad, MORALE_DELTA.win, "win"));
    else if (dealtTroops > takenTroops) pushIf(followups, changeMorale(defSquad, MORALE_DELTA.lose, "lose"));
  }
  // 砦を落としたら、そのランドの全部隊の士気 +5
  if (mode === "fort" && fallen) {
    for (const s of Object.values(state.squads)) {
      if (s.land !== attacker.land || s.status === "routed") continue;
      pushIf(followups, changeMorale(s, MORALE_DELTA.fort, "fort"));
    }
  }

  let defender;
  if (defSquad) defender = defSquad.id;
  else if (mode === "fort") defender = fort.id;
  else defender = homeLand;

  const ev = {
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
    // 兵の増減（SPEC-113 §1.1 の勝ち負けと同じ数え方）。attacker は攻め手が受けた兵、
    // defender は守り手（部隊と砦の守備兵）が受けた兵。耐久は数えない。通知・朝の報告が使う
    losses: { attacker: takenTroops, defender: dealtTroops },
    followups,
  };
  return { ev, info: { mode, defSquad, fort, homeLand: homeLandObj, before, fallen, dealtTroops, takenTroops } };
}

/**
 * 戦闘を 1 回解決する（mutates）。§spec 7.2 の順：回避 → スキル → ダメージ → 反撃。
 * 士気の変化（SPEC-113 §1.1・§1.2）は morale イベントとして followups に入る。
 * @param {object} state
 * @param {object} db
 * @param {() => number} rng
 * @param {object} attacker Squad
 * @param {object} target Squad | Fort | { home: landId }
 * @returns {object} Event(t:"battle")。陥落・敗走・士気などは event.followups に入る
 */
export function resolve(state, db, rng, attacker, target) {
  return fight(state, db, attacker, target, rngDice(rng), rng, false).ev;
}

/** predict 用の写し（戦闘が書き換えるものだけ複製する） */
function scratch(state) {
  const squads = {};
  for (const id of Object.keys(state.squads)) squads[id] = { ...state.squads[id] };
  const forts = {};
  for (const id of Object.keys(state.forts || {})) forts[id] = { ...state.forts[id] };
  const lands = {};
  for (const id of Object.keys(state.lands)) lands[id] = { ...state.lands[id] };
  return { ...state, squads, forts, lands, pending: [] };
}

function range(list) {
  return { min: Math.min(...list), max: Math.max(...list) };
}

/** 予想のラベルの境目（相手に与える見込みの中央 ÷ 自分が受ける見込みの中央） */
export const PREDICT_LABELS = [
  { min: 2.5, label: "overwhelm" },
  { min: 1.4, label: "advantage" },
  { min: 0.7, label: "even" },
  { min: 0.4, label: "disadvantage" },
  { min: -Infinity, label: "hopeless" },
];

/** predict が数えていないもの（UI が 1 行で添える） */
export const PREDICT_EXCLUDES = ["other_battles", "movement", "night"];

function clampPct(p) {
  return Math.max(0, Math.min(100, Math.round(p)));
}

/**
 * 攻撃の見込み（state を変えない・rng を使わない。SPEC-113 §6.3）。
 * 回避とスキルの発動の「起きる / 起きない」の組み合わせを全部試し、兵の幅を出す
 * （最小 = 相手が回避・自分のスキル不発・反撃が命中、最大 = 命中・スキル発動・反撃を回避）。
 * attacker は state の部隊でなくてもよい（予定位置の写し { ...squad, tile } を渡せる）。
 * defender は守る部隊の兵（砦に守備部隊がいなければ砦の守備兵、本拠地に部隊がいなければ 0）。
 * 砦・本拠地の値は陥落の直前のもの（落ちれば守備兵 0・耐久 0。実際の resolve は落ちたあと守備兵 30 に戻す）。
 * @returns {{ attacker:{before,min,max}, defender:{before,min,max}, label:string, excludes:string[],
 *             target:"squad"|"fort"|"home", defenderId, ambush:boolean, counter:boolean,
 *             dealt:{min,max}, taken:{min,max}, fall:"none"|"maybe"|"sure",
 *             fort?:{troops:{before,min,max}, durability:{before,min,max}}, home?:{durability:{before,min,max}},
 *             chances:{evade, skill, counterEvade, counterSkill} }}
 */
export function predict(state, db, attacker, target) {
  const runs = [];
  for (let mask = 0; mask < 16; mask++) {
    const sc = scratch(state);
    const a = { ...attacker };
    sc.squads[attacker.id] = a;
    let t;
    if (isHome(target)) t = { home: target.home };
    else if (isFort(target)) t = sc.forts[target.id] || { ...target };
    else t = sc.squads[target.id] || { ...target };
    const forced = { hit: { evade: !!(mask & 1), skill: !!(mask & 2) }, counter: { evade: !!(mask & 4), skill: !!(mask & 8) } };
    const pick2 = (p, v) => (p <= 0 ? false : p >= 100 ? true : v);
    const dice = {
      evade: (p, side) => pick2(p, forced[side].evade),
      skill: (p, side) => pick2(p, forced[side].skill),
    };
    const { ev, info } = fight(sc, db, a, t, dice, () => 0, true);
    const dTroops = info.defSquad ? Math.max(0, info.defSquad.troops) : info.fort ? Math.max(0, info.fort.troops) : 0;
    const dur = info.fort ? Math.max(0, info.fort.durability) : info.homeLand ? homeDurabilityOf(info.homeLand) : 0;
    runs.push({
      ev,
      info,
      attacker: Math.max(0, a.troops),
      defender: dTroops,
      fortTroops: info.fort ? Math.max(0, info.fort.troops) : 0,
      durability: dur,
      dealt: info.dealtTroops + (info.before.durability - dur),
      taken: info.takenTroops,
      fallen: info.fallen,
    });
  }
  const first = runs[0].info;
  const b = first.before;
  const defBefore = first.defSquad ? b.defender : first.fort ? b.fortTroops : 0;
  const dealt = range(runs.map((r) => r.dealt));
  const taken = range(runs.map((r) => r.taken));
  const dMid = (dealt.min + dealt.max) / 2;
  const tMid = (taken.min + taken.max) / 2;
  const ratio = tMid > 0 ? dMid / tMid : dMid > 0 ? Infinity : 1;
  const label = PREDICT_LABELS.find((x) => ratio >= x.min).label;
  const falls = runs.filter((r) => r.fallen).length;

  const out = {
    attacker: { before: b.attacker, ...range(runs.map((r) => r.attacker)) },
    defender: { before: defBefore, ...range(runs.map((r) => r.defender)) },
    label,
    excludes: [...PREDICT_EXCLUDES],
    target: first.mode,
    defenderId: runs[0].ev.defender,
    ambush: runs[0].ev.ambush,
    counter: runs.some((r) => r.ev.counter),
    dealt,
    taken,
    fall: falls === 0 ? "none" : falls === runs.length ? "sure" : "maybe",
  };
  if (first.mode === "fort") {
    out.fort = {
      troops: { before: b.fortTroops, ...range(runs.map((r) => r.fortTroops)) },
      durability: { before: b.durability, ...range(runs.map((r) => r.durability)) },
    };
  } else if (first.mode === "home") {
    out.home = { durability: { before: b.durability, ...range(runs.map((r) => r.durability)) } };
  }
  // 確率（%）。表示用
  const aHero = heroOf(db, attacker);
  const ap = effectiveParams(aHero, attacker, db);
  const dsq = first.defSquad;
  const dHero = dsq ? heroOf(db, dsq) : null;
  const dp = dHero ? effectiveParams(dHero, dsq, db) : null;
  out.chances = {
    evade: dp && !out.ambush ? clampPct(dp.int) : 0,
    skill: aHero.skill ? clampPct(ap.int) : 0,
    counterEvade: out.counter ? clampPct(ap.int) : 0,
    counterSkill: out.counter && dHero && dHero.skill ? clampPct(dp.int) : 0,
  };
  return out;
}
