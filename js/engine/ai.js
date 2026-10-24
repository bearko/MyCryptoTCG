// ai.js — CPU ランドの指示（SPEC-109 §7.3）
//
// 契約：docs/specs/SPEC-110-engine-contract.md §3 `ai.js`
//   plan(state, db, rng, landId)（mutates。orders.queue だけで指示を積む）
// DOM に触れない純粋関数。乱数は引数の rng だけ。軽さを優先して、1 部隊につき経路探索は数回まで。
//
// 毎ターンの流れ
//   1. 全部隊の policy を fight にする
//   2. 食料の収支が足りなければ、本拠地に近い部隊を「留守番」にする（不足を農作で埋められるまで。最低 1 体は外に残す）。
//      留守番は戦わず、本拠地で農作 → 商業・工作 → 隣のタイルに農地・食料庫を建てて夜を越す
//      （本拠地で夜を越すと兵が回復して、食料の消費が増えるため）
//   3. 自ランドの砦に立っている部隊はそのまま守る。守り手のいない砦には、近くの部隊が入る
//   4. 残りの上位（攻撃力順）を攻め手にし、いちばん近い未所有の砦へ向かい、射程内なら攻める
//      （Epic・Legendary は距離を割り引いて選ぶ。兵が下限に満たなければ、1 日 1 体まで本拠地で休んで兵を増やす。
//        他ランドの砦は、落ちたばかりのもの・守り手の兵が多いものは狙わない）
//   5. それ以外は守り手のいない砦へ向かうか、周りの未占領のタイルを占領し、資源があれば農地・街・採掘場を建てる
//
// SPEC-113（士気と食料）の施策も使う
//   - 配給：通常の配給で食料が 3 日以内に尽きる見込みなら「節約」。余裕があり士気の平均が 40 未満なら「増量」。それ以外は「通常」
//   - 恩賞：本拠地にいる士気 40 未満の部隊に、GUM に余裕があれば
//   - 士気 0 の部隊は、ほかの役目より先に本拠地へ戻して休息（着いた日は恩賞も）

import { within, distance, neighbors } from './hex.js';
import { findPath, reachable, stepCost } from './pathfind.js';
import { troopCap, musterCap, musteredOf, rangeOf } from './heroes.js';
import { queue, projectedTile } from './orders.js';
import { canBuild, yields, upkeep, caps, troopFood, previewRation, setRation, canReward, canConscript } from './economy.js';
import { moraleOf } from './morale.js';
import { farmAmount } from './tuning.js';
import { power, inRange } from './battle.js';

const ENEMY_LAND = 'enemy';

/** 砦の選び方：path のコストからこれを引く（大きいほど遠くても選ぶ） */
export const FORT_BONUS = { rare: 0, epic: 6, legendary: 10 };
/** その砦を狙ってよい兵の下限 */
export const FORT_MIN_TROOPS = { rare: 0, epic: 120, legendary: 550 };
/** 他ランドの砦は、エネミーの砦よりこれだけ遠く見る */
const OWNED_PENALTY = 12;
/** 建築のあとに残しておく GUM */
const GUM_RESERVE = 20;
/** 守り手が向かう砦までの距離の上限 */
const GUARD_RANGE = 14;
/** 通常の配給でこの日数以内に食料が尽きるなら「節約」 */
const RATION_SAVE_DAYS = 3;
/** 士気の平均がこれ未満なら「増量」・恩賞を考える */
const MORALE_LOW = 40;
/** 「増量」にしてよい食料の残り（かつ増量でも 10 日以上もつ） */
const FEAST_MIN_FOOD = 80;
const FEAST_MIN_DAYS = 10;
/** 恩賞のあとに残しておく GUM */
const REWARD_RESERVE = 40;

/** 兵が n 増えたら、1 日の食料の消費がいくつ増えるか（配給込み） */
function extraFood(state, db, landId, n) {
  if (n <= 0) return 0;
  return troopFood(state, db, landId, { extra: n }).total - troopFood(state, db, landId).total;
}

/** 配給を選ぶ（SPEC-113 §6.3 ai.js） */
function chooseRation(state, db, land) {
  const days = (r) => {
    const net = previewRation(state, db, land.id, r).perDay.food;
    return net < 0 ? Math.floor(Math.max(0, land.res.food) / -net) + 1 : null;
  };
  const dNormal = days('normal');
  if (dNormal !== null && dNormal <= RATION_SAVE_DAYS) return 'save';
  const mine = Object.values(state.squads).filter((s) => s.land === land.id && s.status !== 'routed');
  if (mine.length === 0) return 'normal';
  const avg = mine.reduce((a, s) => a + moraleOf(s), 0) / mine.length;
  if (avg < MORALE_LOW && land.res.food >= FEAST_MIN_FOOD) {
    const dFeast = days('feast');
    if (dFeast === null || dFeast > FEAST_MIN_DAYS) return 'feast';
  }
  return 'normal';
}

/** 本拠地にいる（着く予定の）士気の低い部隊に恩賞。積めたら true */
function maybeReward(state, db, squad, land, force = false) {
  if (squad.ap < 2 || projectedTile(squad) !== land.home) return false;
  if (!force && moraleOf(squad) >= MORALE_LOW) return false;
  if (moraleOf(squad) >= 100) return false;
  const chk = canReward(state, db, squad);
  if (!chk.ok || chk.gum - chk.cost < (force ? 0 : REWARD_RESERVE)) return false;
  return queue(state, db, squad.id, { type: 'domestic', kind: 'reward' }).ok;
}

/** 士気 0 の部隊：本拠地へ戻って休息（着いていれば恩賞も） */
function retreat(state, db, squad, hero, land) {
  const here = projectedTile(squad);
  if (here !== land.home) {
    const found = findPath(state, db, at(squad, here), hero, land.home);
    if (!found || found.path.length === 0) return;
    const prefix = affordablePrefix(state, db, squad, hero, found.path, squad.ap);
    if (prefix.length === 0 || !queue(state, db, squad.id, { type: 'move', path: prefix }).ok) return;
    if (prefix[prefix.length - 1] !== land.home) return;
  }
  maybeReward(state, db, squad, land, true);
  if (squad.ap > 0) queue(state, db, squad.id, { type: 'rest' });
}

function heroOf(db, squad) {
  return db.heroes[squad.heroId] || db.heroes[String(squad.heroId)];
}

function at(squad, tile) {
  return tile === squad.tile ? squad : { ...squad, tile };
}

/** 射程内の、自分より兵の少ない敵ランドの部隊 */
function weakEnemyInRange(state, db, squad, here) {
  let best = null;
  for (const o of Object.values(state.squads)) {
    if (o.land === squad.land || o.land === ENEMY_LAND || o.status === 'routed' || o.troops <= 0) continue;
    if (o.troops >= squad.troops) continue;
    // 本拠地に立っている部隊は狙わない（攻撃が本拠地の攻略になり、ランドを脱落させてしまうため）
    const ol = state.lands[o.land];
    if (ol && ol.home === o.tile) continue;
    // 砦に立っている部隊を撃つと砦への攻撃になる。砦は goFort が守りの固さを見て選ぶ
    if (Object.values(state.forts).some((f) => f.tile === o.tile)) continue;
    if (!inRange(state, db, at(squad, here), o.tile)) continue;
    if (!best || o.troops < best.troops) best = o;
  }
  return best;
}

function attackRepeatedly(state, db, squad, targetTile, max) {
  let n = 0;
  while (n < max && squad.ap >= 2 && queue(state, db, squad.id, { type: 'attack', target: targetTile }).ok) n++;
  return n;
}

function domesticNeed(state, db, squad, hero) {
  const land = state.lands[squad.land];
  const r = land.res;
  const net = yields(state, db, squad.land).food - upkeep(state, db, squad.land).food;
  if (r.food < 80 || net < 0) return 'farm';
  if (r.gum < 50) return 'trade';
  if (r.mat < 30) return 'craft';
  return null;
}

/** 経路の、AP で払える先頭部分 */
function affordablePrefix(state, db, squad, hero, path, ap) {
  const out = [];
  let sum = 0;
  for (const i of path) {
    const c = stepCost(state, db, squad, hero, i);
    if (sum + c > ap) break;
    sum += c;
    out.push(i);
  }
  return out;
}

/** 攻め手：いちばん近い未所有の砦へ。射程内なら攻める */
function goFort(state, db, squad, hero, ctx) {
  const here = projectedTile(squad);
  const me = at(squad, here);
  const range = rangeOf(hero);
  const { w, h } = state.map;
  // すでに射程内の砦があれば攻める
  for (const f of Object.values(state.forts)) {
    if (!targetable(state, squad, f)) continue;
    if (distance(here, f.tile, w, h) <= range) {
      if (attackRepeatedly(state, db, squad, f.tile, 4) > 0) return true;
    }
  }
  const costs = reachable(state, db, me, hero, Infinity);
  // 兵の下限は「本拠地で休めば届くか」で見る（届かないうちは本拠地で休んでから向かう）
  const cap = troopCap(hero, squad, db);
  const cands = [];
  for (const f of Object.values(state.forts)) {
    if (!targetable(state, squad, f, cap)) continue;
    let goal = null;
    let gc = Infinity;
    for (const t of within(f.tile, range, w, h)) {
      const c = costs.get(t);
      if (c !== undefined && c < gc) {
        gc = c;
        goal = t;
      }
    }
    if (goal === null) continue;
    const value = gc - FORT_BONUS[f.rank] + (f.owner === ENEMY_LAND ? 0 : OWNED_PENALTY);
    cands.push({ value, goal, fort: f });
  }
  cands.sort((a, b) => a.value - b.value);
  let best = null;
  for (const c of cands) {
    if (squad.troops >= FORT_MIN_TROOPS[c.fort.rank]) {
      best = c;
      break;
    }
    // 兵が足りない：本拠地で休む・徴兵してから向かう。兵を増やすと食料を食うので、1 日に 1 体まで。
    // 兵の増加は人口を消費する（SPEC-113 §2）ので、人口が無ければ戻らない。休息で戻せるのは定員まで、
    // 定員を超えて増やせるのは徴兵だけ（SPEC-113 §2.1）
    const gain = refitGain(state, db, squad, hero);
    const more = extraFood(state, db, squad.land, gain);
    if (!ctx.refit && gain > 0 && more <= ctx.foodRoom) {
      ctx.refit = true;
      ctx.foodRoom -= more;
      return refit(state, db, squad, hero);
    }
  }
  if (!best) return false;
  const found = findPath(state, db, me, hero, best.goal);
  if (!found || found.path.length === 0) return false;
  const prefix = affordablePrefix(state, db, me, hero, found.path, squad.ap);
  if (prefix.length === 0) return false;
  if (!queue(state, db, squad.id, { type: 'move', path: prefix }).ok) return false;
  if (prefix[prefix.length - 1] === best.goal) attackRepeatedly(state, db, squad, best.fort.tile, 4);
  return true;
}

/**
 * 本拠地へ戻って兵を増やしたら、いくつ増えるかの見込み（休息 1 回 + 徴兵 1 回。人口を超えない）。
 * 休息は定員まで、徴兵は兵の上限まで（SPEC-113 §2.1）
 */
function refitGain(state, db, squad, hero) {
  let pop = Math.max(0, Math.floor(state.lands[squad.land].res.pop || 0));
  const t = Math.max(0, squad.troops || 0);
  const draft = Math.max(0, Math.min(Math.floor(pop * 0.3), troopCap(hero, squad, db) - t));
  pop -= draft;
  const mustered = Math.max(musteredOf(squad) + draft, t + draft);
  const heal = Math.max(0, Math.min(Math.min(troopCap(hero, squad, db), mustered) - t - draft, hero.params.lead * 4, pop));
  return draft + heal;
}

/** 本拠地へ戻って兵を増やす（定員より少なければ休息、定員に届いていれば徴兵。大きな砦へ向かう前に） */
function refit(state, db, squad, hero) {
  const land = state.lands[squad.land];
  const here = projectedTile(squad);
  if (here !== land.home) {
    const found = findPath(state, db, at(squad, here), hero, land.home);
    if (!found || found.path.length === 0) return false;
    const prefix = affordablePrefix(state, db, squad, hero, found.path, squad.ap);
    if (prefix.length === 0 || !queue(state, db, squad.id, { type: 'move', path: prefix }).ok) return false;
    if (prefix[prefix.length - 1] !== land.home) return true;
  }
  // 徴兵は 1 回まで（人口を使い切ると、戦いで減った兵を夜に戻せなくなる）
  if (squad.ap >= 2 && canConscript(state, db, squad).ok) queue(state, db, squad.id, { type: 'domestic', kind: 'conscript' });
  if (squad.ap > 0) queue(state, db, squad.id, { type: 'rest' });
  return true;
}

function claimable(state, landId, i) {
  const t = state.map.tiles[i];
  if (t.owner !== null || t.fort) return false;
  for (const l of Object.values(state.lands)) if (l.home === i) return false;
  return true;
}

/** 周りの未占領のタイルへ移動して占領する（最大 n 回） */
function expand(state, db, squad, hero, n) {
  for (let k = 0; k < n && squad.ap >= 1; k++) {
    const here = projectedTile(squad);
    if (claimable(state, squad.land, here) && queue(state, db, squad.id, { type: 'claim' }).ok) continue;
    const me = at(squad, here);
    const costs = reachable(state, db, me, hero, squad.ap - 1);
    let goal = null;
    let gc = Infinity;
    for (const [t, c] of costs) {
      if (t === here || !claimable(state, squad.land, t)) continue;
      const terr = db.terrain[state.map.tiles[t].terrain];
      // 建てられる地形を少し優先する
      const v = c - (terr && terr.buildable ? 0.5 : 0);
      if (v < gc) {
        gc = v;
        goal = t;
      }
    }
    if (goal === null) return;
    const found = findPath(state, db, me, hero, goal);
    if (!found || found.path.length === 0) return;
    if (!queue(state, db, squad.id, { type: 'move', path: found.path }).ok) return;
    if (!queue(state, db, squad.id, { type: 'claim' }).ok) return;
  }
}

/** 守り手：自ランドの砦へ向かって立つ。向かう先が無ければ false */
function goGuard(state, db, squad, hero, forts, claimed) {
  if (squad.tile !== projectedTile(squad)) return false;
  const here = squad.tile;
  for (const f of state.forts ? Object.values(state.forts) : []) {
    if (f.owner === squad.land && f.tile === here) return true; // もう立っている。そのまま守る
  }
  const { w, h } = state.map;
  let best = null;
  for (const f of forts) {
    if (claimed.has(f.id)) continue;
    const d = distance(here, f.tile, w, h);
    if (d > GUARD_RANGE) continue;
    if (!best || d < best.d) best = { f, d };
  }
  if (!best) return false;
  const found = findPath(state, db, squad, hero, best.f.tile);
  if (!found || found.path.length === 0) return false;
  if (!queue(state, db, squad.id, { type: 'move', path: found.path }).ok) return false;
  claimed.add(best.f.id);
  return true;
}

/** 立っているタイルに建てる。budget は今ターンに使ってよい GUM・素材の残り（mutates） */
function tryBuild(state, db, squad, budget) {
  if (squad.ap < 2) return;
  const here = projectedTile(squad);
  const land = state.lands[squad.land];
  const t = state.map.tiles[here];
  // 指示フェーズではまだ占領していない（claim を積んだだけ）タイルには建てられないので、占領済みのタイルだけ
  if (t.owner !== squad.land || t.facility) return;
  const net = yields(state, db, squad.land).food - upkeep(state, db, squad.land).food;
  const kinds = land.res.food < 120 || net < 5 ? ['farm', 'town', 'mine'] : ['town', 'farm', 'mine'];
  if (land.res.mat < 40) kinds.unshift('mine');
  for (const kind of kinds) {
    const chk = canBuild(state, db, squad.land, here, kind, at(squad, here));
    if (!chk.ok) continue;
    if (budget.gum - chk.cost.gum < GUM_RESERVE || budget.mat < chk.cost.mat) continue;
    if (queue(state, db, squad.id, { type: 'build', kind, rush: 0 }).ok) {
      budget.gum -= chk.cost.gum;
      budget.mat -= chk.cost.mat;
      return;
    }
  }
}

/** 他ランドの砦を狙うのは、守り手の兵よりこの倍率以上の兵があるときだけ */
const OWNED_GUARD_RATIO = 1.5;
/** 守り手のいない砦へ、この距離以内の部隊が入る */
const NEAR_GUARD = 4;
/** 食料の見込みに足す余裕 */
const FOOD_MARGIN = 20;

/** 食料の 1 日の収支（産出 − 消費） */
function foodNet(state, db, landId) {
  return yields(state, db, landId).food - upkeep(state, db, landId).food;
}

/** 砦に立っている（立つ予定の）そのランドの部隊のうち、兵の最大 */
function guardTroops(state, fort) {
  let best = 0;
  for (const s of Object.values(state.squads)) {
    if (s.land !== fort.owner || s.status === 'routed') continue;
    if (s.tile === fort.tile || projectedTile(s) === fort.tile) best = Math.max(best, s.troops);
  }
  return best;
}

/** 狙ってよい砦か（自分の砦・兵が下限に満たない・守りの固い他ランドの砦は狙わない） */
function targetable(state, squad, f, minTroops = squad.troops) {
  if (f.owner === squad.land || minTroops < FORT_MIN_TROOPS[f.rank]) return false;
  // 落ちたばかりの砦は攻められない（turn.js の FORT_SHIELD_DAYS と同じ決まり）
  if (typeof f.fallenDay === 'number' && state.day - f.fallenDay <= 1) return false;
  if (f.owner !== ENEMY_LAND && squad.troops < guardTroops(state, f) * OWNED_GUARD_RATIO) return false;
  return true;
}

/**
 * 留守番（本拠地で農作する部隊）を選ぶ。食料の収支が足りないときだけ。
 * 本拠地に近い部隊（同じなら攻撃力の低いもの）から、明日の不足を農作で埋められるまで。最低 1 体は外に残す。
 */
function pickStewards(state, db, land, ranked) {
  const out = new Set();
  if (ranked.length < 2) return out;
  const y = yields(state, db, land.id).food;
  const up = upkeep(state, db, land.id).food;
  let short = up - y - land.res.food + FOOD_MARGIN;
  if (short <= 0 && land.res.food >= 100) return out;
  const { w, h } = state.map;
  const cands = ranked
    .map((s, i) => ({ s, i, d: distance(s.tile, land.home, w, h) }))
    .filter((c) => c.s.ap >= 4) // 敗走明け（AP 0）などは農作できない
    .sort((a, b) => a.d - b.d || b.i - a.i);
  for (const c of cands) {
    if (out.size >= ranked.length - 1) break;
    if (out.size > 0 && short <= 0) break;
    out.add(c.s);
    const hero = heroOf(db, c.s);
    const gov = hero && hero.params ? hero.params.gov : 0;
    // 戻るのに使う AP を見込む（1 タイル 1.5 くらい）
    const ap = Math.max(0, c.s.ap - Math.ceil(c.d * 1.5));
    short -= Math.floor(ap / 2) * farmAmount(gov);
  }
  return out;
}

/** 今日の指示（休息・徴兵）で増える兵の見込み */
function plannedGrowth(state, db, landId) {
  const land = state.lands[landId];
  let n = 0;
  // 兵の増加は人口を消費する（SPEC-113 §2）。人口を超えては増えない
  let pop = Math.max(0, Math.floor(land.res.pop || 0));
  for (const s of Object.values(state.squads)) {
    if (s.land !== landId || !s.orders) continue;
    const hero = heroOf(db, s);
    if (!hero) continue;
    const cap = troopCap(hero, s, db);
    // 休息は定員まで、徴兵は上限まで（徴兵は定員も増やす。SPEC-113 §2.1）
    let mustered = musteredOf(s);
    let t = s.troops;
    for (const o of s.orders) {
      let add = 0;
      if (o.type === 'rest') {
        add = hero.params.lead * 2 * (projectedTile(s) === land.home ? 2 : 1);
        add = Math.min(add, Math.min(cap, mustered) - t);
      } else if (o.type === 'domestic' && o.kind === 'conscript') {
        add = Math.min(Math.floor(pop * 0.3), cap - t);
        mustered = Math.max(mustered + Math.max(0, add), t + Math.max(0, add));
      }
      add = Math.max(0, Math.min(add, pop));
      t += add;
      pop -= add;
    }
    n += Math.max(0, t - s.troops);
  }
  return n;
}

/** 本拠地の隣で建てるもの（食料庫が足りなければ食料庫、それ以外は農地。農地はランクを上げられるものから）。建てたら true */
function stewardBuild(state, db, squad, hero, land, budget) {
  const { w, h, tiles } = state.map;
  const y = yields(state, db, land.id).food;
  const up = upkeep(state, db, land.id).food;
  const cap = caps(state, db, land.id).food;
  const wantGranary = up - y > cap - 40;
  let best = null;
  for (const j of neighbors(land.home, w, h)) {
    const t = tiles[j];
    if (t.owner !== land.id) continue;
    const c = stepCost(state, db, squad, hero, j);
    if (!Number.isFinite(c) || c + 2 > squad.ap) continue;
    for (const kind of wantGranary ? ['granary', 'farm'] : ['farm']) {
      const chk = canBuild(state, db, land.id, j, kind, at(squad, j));
      if (!chk.ok || budget.gum - chk.cost.gum < GUM_RESERVE || budget.mat < chk.cost.mat) continue;
      // 食料庫を先に。農地は草原・ランクの上がるものを先に
      const v = (kind === 'granary' ? 100 : 0) + (t.facility ? 10 : 0) + (t.terrain === 'grass' ? 5 : 0) - c;
      if (!best || v > best.v) best = { j, kind, chk, v };
    }
  }
  if (!best) return false;
  if (!queue(state, db, squad.id, { type: 'move', path: [best.j] }).ok) return false;
  if (!queue(state, db, squad.id, { type: 'build', kind: best.kind, rush: 0 }).ok) return true;
  budget.gum -= best.chk.cost.gum;
  budget.mat -= best.chk.cost.mat;
  return true;
}

/** 本拠地の隣の、いちばん安く入れるタイルへ出る（本拠地で夜を越すと兵が増えて、食料の消費が増えるため） */
function stepOut(state, db, squad, hero, land) {
  const { w, h } = state.map;
  let best = null;
  for (const j of neighbors(land.home, w, h)) {
    const c = stepCost(state, db, squad, hero, j);
    if (!Number.isFinite(c) || c > squad.ap) continue;
    if (Object.values(state.squads).some((o) => o.land !== squad.land && o.tile === j)) continue;
    if (!best || c < best.c) best = { j, c };
  }
  if (best) queue(state, db, squad.id, { type: 'move', path: [best.j] });
}

/**
 * 留守番：本拠地へ戻り、明日の消費に足りるまで農作。余った AP で商業・工作。
 * 兵が足りていれば、最後に隣のタイルへ出て（農地・食料庫を建てて）夜を越す。
 * food は留守番どうしで共有する、農作の見込み（mutates）
 */
function steward(state, db, squad, hero, land, budget, plan) {
  const here = projectedTile(squad);
  if (here !== land.home) {
    const found = findPath(state, db, at(squad, here), hero, land.home);
    if (!found || found.path.length === 0) return;
    const prefix = affordablePrefix(state, db, squad, hero, found.path, squad.ap);
    if (prefix.length === 0 || !queue(state, db, squad.id, { type: 'move', path: prefix }).ok) return;
    if (prefix[prefix.length - 1] !== land.home) return;
  }
  const gov = Math.max(0, hero.params ? hero.params.gov : 0);
  const per = farmAmount(gov);
  // 明日の消費に足りるまで（上限で止まるので、上限に届いたらやめる）。出るための AP を 2 残す
  while (squad.ap >= 4 && plan.food + plan.y - plan.up < FOOD_MARGIN && plan.food < plan.cap) {
    if (!queue(state, db, squad.id, { type: 'domestic', kind: 'farm' }).ok) break;
    plan.food = Math.min(plan.cap, plan.food + per);
  }
  const r = land.res;
  maybeReward(state, db, squad, land);
  // 夜の回復で戻せるのは定員まで（SPEC-113 §2.1）。定員の 6 割に満たなければ本拠地で夜を越す
  const lowTroops = squad.troops < musterCap(hero, squad, db) * 0.6 && land.res.pop > 0;
  if (squad.ap >= 4 && r.gum < 80) queue(state, db, squad.id, { type: 'domestic', kind: 'trade' });
  if (squad.ap >= 4 && r.mat < 40) queue(state, db, squad.id, { type: 'domestic', kind: 'craft' });
  if (lowTroops) return; // 兵が少なければ本拠地で夜を越して回復する
  if (!stewardBuild(state, db, squad, hero, land, budget)) stepOut(state, db, squad, hero, land);
}

/**
 * mutates。そのランドの全部隊に指示を積む。
 * @param {object} state
 * @param {object} db
 * @param {() => number} rng
 * @param {string} landId
 */
export function plan(state, db, rng, landId) {
  const land = state.lands[landId];
  if (!land || land.alive === false) return;
  const all = Object.values(state.squads).filter((s) => s.land === landId && s.status !== 'routed');
  for (const s of all) s.policy = 'fight';
  // 配給（AP を使わない）
  setRation(state, landId, chooseRation(state, db, land));
  // 士気 0 の部隊は先に本拠地へ戻して休ませる（ほかの役目に数えない）
  const fleeing = all.filter((s) => moraleOf(s) === 0 && s.ap > 0);
  for (const s of fleeing) {
    const hero = heroOf(db, s);
    if (hero) retreat(state, db, s, hero, land);
  }
  const mine = all.filter((s) => !fleeing.includes(s));
  // 攻撃力で並べる
  const ranked = mine
    .map((s) => ({ s, atk: power(state, db, s).atk, r: rng() }))
    .sort((a, b) => b.atk - a.atk || a.r - b.r)
    .map((x) => x.s);
  // 1. 食料が足りなければ留守番を 1 体
  const stews = pickStewards(state, db, land, ranked);
  const rest = ranked.filter((s) => !stews.has(s));
  // 2. 自ランドの砦の守り：いま立っている部隊はそのまま守る（1 砦 1 体）
  const holding = new Map(); // fortId -> squad
  for (const f of Object.values(state.forts)) {
    if (f.owner !== landId) continue;
    let g = null;
    for (const s of rest) if (s.tile === f.tile && (!g || s.troops > g.troops)) g = s;
    if (g) holding.set(f.id, g);
  }
  // 守り手のいない自ランドの砦には、近く（NEAR_GUARD 以内）の部隊を 1 体ずつ向かわせる（砦を落とした攻め手が、そのまま入る）
  const going = new Map(); // squadId -> fort
  for (const f of Object.values(state.forts)) {
    if (f.owner !== landId || holding.has(f.id)) continue;
    let g = null;
    for (const s of rest) {
      if ([...holding.values()].includes(s) || going.has(s.id)) continue;
      const d = distance(s.tile, f.tile, state.map.w, state.map.h);
      if (d <= NEAR_GUARD && (!g || d < g.d)) g = { s, d };
    }
    if (g) going.set(g.s.id, f);
  }
  const holders = new Set(holding.values());
  const free = rest.filter((s) => !holders.has(s) && !going.has(s.id));
  // 3. 残りの上位を攻め手に
  const nAtk = free.length >= 3 ? Math.ceil(free.length / 2) : Math.min(1, free.length);
  let attackers = new Set(free.slice(0, nAtk).map((s) => s.id));
  if (attackers.size === 0 && holders.size >= 2) {
    // 全員が砦に張り付いたら、いちばん強い守り手を攻めに出す
    const strongest = [...holders].sort((a, b) => b.troops - a.troops)[0];
    attackers = new Set([strongest.id]);
    for (const [fid, s] of holding) if (s === strongest) holding.delete(fid);
  }
  const toGuard = Object.values(state.forts).filter(
    (f) => f.owner === landId && !holding.has(f.id) && ![...going.values()].includes(f)
  );
  const guardClaimed = new Set();
  const budget = { gum: land.res.gum, mat: land.res.mat };
  // 1 日に 1 体だけ、本拠地で兵を増やしに戻ってよい
  // foodRoom：食料の上限まで農作したとして、あと何増やせるか（1 日の消費で）
  const ctx = {
    refit: false,
    foodRoom: caps(state, db, landId).food - (upkeep(state, db, landId).food - yields(state, db, landId).food) - 60,
  };
  // 留守番は最後に回す（ほかの部隊の休息・徴兵で増える兵の分も、明日の消費として見込むため）
  for (const squad of ranked) {
    if (squad.ap <= 0 || stews.has(squad)) continue;
    const hero = heroOf(db, squad);
    if (!hero) continue;
    const enemy = weakEnemyInRange(state, db, squad, squad.tile);
    if (enemy) attackRepeatedly(state, db, squad, enemy.tile, 2);

    if (squad.tile === land.home && squad.ap >= 2) {
      maybeReward(state, db, squad, land);
      const kind = domesticNeed(state, db, squad, hero);
      if (kind) queue(state, db, squad.id, { type: 'domestic', kind });
    }
    if (going.has(squad.id)) {
      goGuard(state, db, squad, hero, [going.get(squad.id)], new Set());
      continue;
    }
    const holdsFort = [...holding.values()].includes(squad);
    if (holdsFort) {
      // 砦を守る（動かない）。射程内の弱い敵は上で叩いた
      continue;
    }
    if (attackers.has(squad.id)) {
      if (!goFort(state, db, squad, hero, ctx)) expand(state, db, squad, hero, 2);
    } else if (goGuard(state, db, squad, hero, toGuard, guardClaimed)) {
      // 砦へ向かう
    } else {
      tryBuild(state, db, squad, budget);
      expand(state, db, squad, hero, 3);
    }
  }

  const foodPlan = {
    food: land.res.food,
    y: yields(state, db, landId).food,
    up: upkeep(state, db, landId).food + extraFood(state, db, landId, plannedGrowth(state, db, landId)),
    cap: caps(state, db, landId).food,
  };
  for (const squad of ranked) {
    if (squad.ap <= 0 || !stews.has(squad)) continue;
    const hero = heroOf(db, squad);
    if (hero) steward(state, db, squad, hero, land, budget, foodPlan);
  }
}
