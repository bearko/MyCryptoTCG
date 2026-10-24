// tools/sim-lib.mjs — 無人シミュレーションの中身（tools/sim.mjs と tests/balance.test.mjs が使う）
//
// runCpu(db, seed)：全ランドを ai.plan で 28 日（または終了まで）回し、1 シードの集計を返す。
// runPlayer(db, seed, policy)：プレイヤーのランド（ocean）だけを決め打ちの方針で動かし、
//   残りのランドは CPU で 28 日回す（SPEC-113 §5 の目標の表を確かめるため）。
//
// 方針（SPEC-113 §5）
//   none       指示を出さない
//   farm1      統治力のいちばん高い 1 人が、本拠地で農作を 1 回
//   farmMax    1 人（農作 1 回の量 × 積める回数がいちばん多い部隊）が、AP いっぱい農作
//   conscript2 本拠地で 1 日 2 回ずつ徴兵する（兵の上限まで余裕のある部隊から。ほかの指示は出さない）
//
// 「差し引き」は UI の「このあと」（SPEC-114）と同じ数え方：breakdown の食料の net に、
// 積んだ内政の previewDomestic(...).perDay.food を足したもの（農作は食料の上限で止まる）。
// あわせて、上限で止めない「流れ」（産出 + 農作の量 − 消費。消費は徴兵を足した兵で数える）も出す。

import { newGame } from '../js/state.js';
import { planCpu, execute, beginTurn } from '../js/engine/turn.js';
import { makeRng } from '../js/engine/rng.js';
import { distance } from '../js/engine/hex.js';
import { tileCount, score } from '../js/engine/season.js';
import { moraleOf, rationOf } from '../js/engine/morale.js';
import { breakdown, previewDomestic, yields, troopFood } from '../js/engine/economy.js';
import { queue, projectedTile } from '../js/engine/orders.js';
import { effectiveParams, troopCap } from '../js/engine/heroes.js';
import { farmAmount } from '../js/engine/tuning.js';

export const PLAYER_LAND = 'ocean';
export const POLICIES = ['none', 'farm1', 'farmMax', 'conscript2'];
export const DAYS = 28;

function heroOf(db, squad) {
  return db.heroes[squad.heroId] || db.heroes[String(squad.heroId)];
}

/** シードごとの CPU の乱数（tools/sim.mjs のこれまでの値と同じ） */
function rngFor(seed) {
  return makeRng(seed * 7919 + 13);
}

// ---------------------------------------------------------------- 全ランド CPU

/**
 * 全ランドを CPU で回す。
 * @returns {object} { seed, day, end, fallen, fromEnemy, starves, battles, moves, deserted, zeroed, saveDays, feastDays,
 *   rewards, morale:{sum,n,shaken}, legendary(3 ヘックス以内に来たか), clear, maxMs, sumMs, days, lands:[行], enemyForts }
 */
export function runCpu(db, seed) {
  const state = newGame({ seed, playerLand: PLAYER_LAND, db });
  for (const l of Object.values(state.lands)) l.cpu = true;
  const rng = rngFor(seed);
  const legend = Object.values(state.forts).find((f) => f.rank === 'legendary');
  const { w, h } = state.map;
  const closest = {};
  const r = {
    seed, fallen: 0, fromEnemy: 0, starves: 0, battles: 0, moves: 0, deserted: 0, zeroed: 0,
    saveDays: 0, feastDays: 0, rewards: 0, maxMs: 0, sumMs: 0, days: 0,
  };
  const zeroed = new Set();
  const landStarves = {};
  const landDeserted = {};
  while (!state.ended && state.day <= DAYS) {
    const t0 = performance.now();
    planCpu(state, db, rng);
    for (const l of Object.values(state.lands)) {
      if (l.id === 'enemy' || l.alive === false) continue;
      const ra = rationOf(l);
      if (ra === 'save') r.saveDays++;
      else if (ra === 'feast') r.feastDays++;
    }
    for (const e of execute(state, db, rng)) {
      if (e.t === 'fort_fallen') { r.fallen++; if (e.from === 'enemy') r.fromEnemy++; }
      else if (e.t === 'starve') { r.starves++; landStarves[e.land] = (landStarves[e.land] || 0) + 1; }
      else if (e.t === 'move') r.moves++;
      else if (e.t === 'battle') r.battles++;
      else if (e.t === 'desert') {
        r.deserted += e.amount;
        const sq = state.squads[e.squad];
        if (sq) landDeserted[sq.land] = (landDeserted[sq.land] || 0) + e.amount;
        if (e.left === 0) zeroed.add(e.squad);
      } else if (e.t === 'domestic' && e.kind === 'reward' && e.cost > 0) r.rewards++;
    }
    for (const s of Object.values(state.squads)) {
      const d = distance(s.tile, legend.tile, w, h);
      if (closest[s.land] === undefined || d < closest[s.land]) closest[s.land] = d;
    }
    if (!state.ended) beginTurn(state, db);
    const ms = performance.now() - t0;
    r.maxMs = Math.max(r.maxMs, ms);
    r.sumMs += ms;
    r.days++;
  }
  r.zeroed = zeroed.size;
  r.day = state.day;
  r.end = state.ended || { reason: 'none', winner: null };
  r.clear = r.end.reason === 'clear';
  r.morale = { sum: 0, n: 0, shaken: 0 };
  for (const s of Object.values(state.squads)) {
    if (s.status === 'routed') continue;
    r.morale.sum += moraleOf(s);
    r.morale.n += 1;
    if (moraleOf(s) < 20) r.morale.shaken++;
  }
  r.legendary = Math.min(...Object.values(closest)) <= 3;
  r.lands = [];
  for (const l of Object.values(state.lands)) {
    if (l.id === 'enemy') continue;
    const sq = Object.values(state.squads).filter((s) => s.land === l.id);
    const ok = sq.filter((s) => s.status !== 'routed');
    r.lands.push({
      id: l.id,
      fortPoints: l.fortPoints,
      forts: Object.values(state.forts).filter((f) => f.owner === l.id).length,
      tiles: tileCount(state, l.id),
      heroes: sq.length,
      troops: sq.reduce((a, s) => a + s.troops, 0),
      gum: l.res.gum,
      food: l.res.food,
      pop: l.res.pop,
      moraleAvg: ok.length ? Math.round(ok.reduce((a, s) => a + moraleOf(s), 0) / ok.length) : '-',
      moraleMin: ok.length ? Math.min(...ok.map(moraleOf)) : '-',
      ration: rationOf(l),
      starves: landStarves[l.id] || 0,
      deserted: landDeserted[l.id] || 0,
      legend: closest[l.id] ?? '-',
      score: score(state, db, l.id).total,
      alive: l.alive,
    });
  }
  r.enemyForts = Object.values(state.forts).filter((f) => f.owner === 'enemy').map((f) => f.rank[0]).join('');
  return r;
}

// ---------------------------------------------------------------- プレイヤーの方針

/** 本拠地に立っていて、内政を積める（AP 2 以上・敗走していない）プレイヤーの部隊 */
function homeSquads(state, landId) {
  const land = state.lands[landId];
  return Object.values(state.squads).filter(
    (s) => s.land === landId && s.status !== 'routed' && (s.ap || 0) >= 2 && projectedTile(s) === land.home
  );
}

function farmPer(db, s) {
  const hero = heroOf(db, s);
  return hero ? farmAmount(effectiveParams(hero, s, db).gov) : 0;
}

/**
 * mutates。その日のプレイヤーの指示を、方針どおりに積む。
 * @returns {{ net:number, flow:number, farms:number, conscripts:number, drafted:number }}
 *   net：UI の「このあと」（breakdown の net + 積んだ内政の perDay.food）
 *   flow：上限で止めない流れ（産出 + 農作の量 − 消費。消費は徴兵で増える兵を足して数える）
 */
export function queuePolicy(state, db, policy, landId = PLAYER_LAND) {
  const out = { net: breakdown(state, db, landId).food.net, flow: 0, farms: 0, conscripts: 0, drafted: 0 };
  let farmed = 0;
  let drafted = 0;
  const push = (s, kind) => {
    const p = previewDomestic(state, db, s, kind);
    if (!p.ok) return false;
    if (!queue(state, db, s.id, { type: 'domestic', kind }).ok) return false;
    out.net += p.perDay.food;
    if (kind === 'farm') {
      out.farms++;
      farmed += farmPer(db, s);
    } else if (kind === 'conscript') {
      out.conscripts++;
      drafted += p.delta.troops;
    }
    return true;
  };
  const mine = homeSquads(state, landId);
  if (policy === 'farm1' && mine.length) {
    const s = [...mine].sort((a, b) => farmPer(db, b) - farmPer(db, a))[0];
    push(s, 'farm');
  } else if (policy === 'farmMax' && mine.length) {
    const s = [...mine].sort((a, b) => Math.floor(b.ap / 2) * farmPer(db, b) - Math.floor(a.ap / 2) * farmPer(db, a))[0];
    while (push(s, 'farm'));
  } else if (policy === 'conscript2') {
    const room = (s) => {
      const hero = heroOf(db, s);
      return hero ? troopCap(hero, s, db) - s.troops : 0;
    };
    let n = 0;
    for (const s of [...mine].sort((a, b) => room(b) - room(a))) {
      while (n < 2 && push(s, 'conscript')) n++;
      if (n >= 2) break;
    }
  } else if (policy !== 'none' && !POLICIES.includes(policy)) {
    throw new Error(`unknown policy: ${policy}`);
  }
  out.drafted = drafted;
  const pop = state.lands[landId].res.pop - drafted;
  out.flow = yields(state, db, landId).food + farmed - (Math.floor(Math.max(0, pop) / 10) + troopFood(state, db, landId, { extra: drafted }).total);
  return out;
}

/**
 * プレイヤーのランドを方針どおりに動かし、ほかのランドは CPU で 28 日回す。
 * @returns {object} { seed, policy, net1, flow1, actual1, firstDeficit, foodOut, starveDays, deserted,
 *   troops1, troops28, muster28, moraleAvg, moraleMin, squadsAlive, alive, nets:[日ごとの net], flows:[日ごとの流れ],
 *   canDraftDays, draftDays, drafted, popZeroDays, pop28 }
 *   net1 / flow1 / actual1：1 日目の差し引き（UI の「このあと」/ 上限で止めない流れ / 実際の食料の増減）
 *   firstDeficit：流れ（上限で止めない差し引き）が初めてマイナスになった日（null は 28 日まで無し）
 *   foodOut：食料が初めて尽きた（飢えた）日（null は 28 日まで無し）
 *   canDraftDays：朝の時点で、本拠地にいる部隊のどれかが徴兵できた日の数（previewDomestic が ok。SPEC-113 §2.1 の「人口の罠」を見る）
 *   draftDays / drafted：方針で実際に徴兵した日の数 / 徴兵で増えた兵の合計
 *   popZeroDays：朝の人口が 4 未満（徴兵で 1 人も移せない）だった日の数。pop28 は最後の人口
 */
export function runPlayer(db, seed, policy) {
  const state = newGame({ seed, playerLand: PLAYER_LAND, db });
  const me = state.playerLand;
  const rng = rngFor(seed);
  const r = {
    seed, policy, net1: null, flow1: null, actual1: null, firstDeficit: null, foodOut: null,
    starveDays: 0, deserted: 0, nets: [], flows: [], canDraftDays: 0, draftDays: 0, drafted: 0, popZeroDays: 0,
    troops1: Object.values(state.squads).filter((s) => s.land === me).reduce((a, s) => a + s.troops, 0),
  };
  while (!state.ended && state.day <= DAYS) {
    planCpu(state, db, rng);
    const day = state.day;
    const land = state.lands[me];
    const before = land.res.food;
    if (land.alive !== false) {
      if (homeSquads(state, me).some((s) => previewDomestic(state, db, s, 'conscript').ok)) r.canDraftDays++;
      if (land.res.pop < 4) r.popZeroDays++;
    }
    const q = land.alive !== false ? queuePolicy(state, db, policy, me) : { net: 0, flow: 0 };
    if (q.conscripts) {
      r.draftDays++;
      r.drafted += q.drafted;
    }
    for (const e of execute(state, db, rng)) {
      if (e.t === 'starve' && e.land === me) {
        r.starveDays++;
        if (r.foodOut === null) r.foodOut = day;
      } else if (e.t === 'desert') {
        const s = state.squads[e.squad];
        if (s && s.land === me) r.deserted += e.amount;
      }
    }
    r.nets.push(q.net);
    if (day === 1) {
      r.net1 = q.net;
      r.flow1 = q.flow;
      r.actual1 = land.res.food - before;
    }
    r.flows.push(q.flow);
    if (q.flow < 0 && r.firstDeficit === null && land.alive !== false) r.firstDeficit = day;
    if (!state.ended) beginTurn(state, db);
  }
  const sq = Object.values(state.squads).filter((s) => s.land === me);
  const ok = sq.filter((s) => s.status !== 'routed');
  r.troops28 = sq.reduce((a, s) => a + s.troops, 0);
  r.muster28 = sq.reduce((a, s) => a + (typeof s.mustered === 'number' ? s.mustered : s.troops), 0);
  r.pop28 = state.lands[me].res.pop;
  r.squadsAlive = sq.filter((s) => s.troops > 0).length;
  r.moraleAvg = ok.length ? Math.round(ok.reduce((a, s) => a + moraleOf(s), 0) / ok.length) : null;
  r.moraleMin = ok.length ? Math.min(...ok.map(moraleOf)) : null;
  r.alive = state.lands[me].alive !== false;
  r.day = state.day;
  return r;
}
