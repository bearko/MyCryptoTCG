// turn.js — 1 日（1 ターン）の進行：指示フェーズの始まり・CPU の指示・実行フェーズ・日の終わり
//
// 契約：docs/specs/SPEC-110-engine-contract.md §3 `turn.js`
// 進み方：docs/specs/SPEC-109-mycryptowars-mvp.md §7.1
// DOM に触れない純粋関数。乱数は引数の rng だけ。
//
// 実行フェーズの決まり（この実装で決めたこと。SPEC-110 の「実装で決めたこと」にも書く）
// - execute の始めに、全部隊の ap を apMax に戻す（queue は指示フェーズに ap を引いているため）。
//   実行中はこの ap から実際のコストを引き、足りなければ blocked(ap) で残りの指示を捨てる
// - ラウンドごとに部隊の順番を rng で混ぜ、各部隊の orders[0] を 1 歩だけ進める。
//   move は 1 タイル、ほかの指示は 1 回で終わる。ラウンドは MAX_ROUNDS で打ち切る
// - 接敵：次のタイルに敵（部隊・砦・本拠地）がいるとき、または途中の歩みで敵ランドの部隊と隣り合ったとき。
//   ignore は進む（次のタイルが塞がれていれば blocked(enemy)）、fight はその場で battle.resolve
//   （同じ相手とは 1 日 1 回）、ask は残りの指示を捨てて ask イベント。最後の 1 歩では隣接の接敵を見ない
//   （「移動して攻撃」の攻撃が ask で消えないように）
// - 体力減の地形に入ると兵が減る：季節が合えば −3%、always は −1%（兵が 1 以上なら 1 は残す）

import { neighbors, within } from './hex.js';
import { shuffle } from './rng.js';
import { stepCost } from './pathfind.js';
import { visionOf, troopCap, subMods, effectiveParams } from './heroes.js';
import { applyDaily, tickBuilds, startBuild, domestic, rest } from './economy.js';
import { apMax, AP_COST } from './orders.js';
import { resolve, inRange } from './battle.js';
import { plan } from './ai.js';
import { seasonOf, dayOfWeek, tallyWeek, checkEnd } from './season.js';
import { say, uiText } from './lines.js';

export const ENEMY_LAND = 'enemy';
/** 実行フェーズのラウンドの上限（無限ループ防止） */
export const MAX_ROUNDS = 120;
const HP_LOSS_SEASONAL = 0.03;
const HP_LOSS_ALWAYS = 0.01;

function heroOf(db, squad) {
  return db.heroes[squad.heroId] || db.heroes[String(squad.heroId)];
}

function realLands(state) {
  return Object.values(state.lands).filter((l) => l.id !== ENEMY_LAND);
}

/**
 * mutates。指示フェーズの始まり。
 * 敗走中の部隊は、この日 AP 0 で兵を lead × 3 に戻して復帰する。奇襲された部隊は AP 半分を消費する。
 */
export function beginTurn(state, db) {
  state.phase = state.ended ? 'ended' : 'orders';
  state.log = [];
  for (const s of Object.values(state.squads)) {
    const hero = heroOf(db, s);
    s.orders = [];
    s.ap = hero ? apMax(hero, s, db) : 0;
    if (s.status === 'routed') {
      s.status = 'ok';
      s.troops = hero ? effectiveParams(hero, s, db).lead * 3 : 0;
      const land = state.lands[s.land];
      if (land && land.home != null) s.tile = land.home;
    }
    s.ambushed = false;
  }
}

/** mutates。CPU の全ランド（生きているもの）に ai.plan */
export function planCpu(state, db, rng) {
  for (const land of realLands(state)) {
    if (land.cpu && land.alive !== false) plan(state, db, rng, land.id);
  }
}

/**
 * そのタイルにいる、landId から見た攻撃対象。本拠地 → 砦 → 部隊（兵の多い順）の順で探す。
 * @returns {null | object} Squad | Fort | { home: landId }
 */
export function targetAt(state, landId, tile) {
  for (const l of realLands(state)) {
    if (l.id !== landId && l.alive !== false && l.home === tile) return { home: l.id };
  }
  for (const f of Object.values(state.forts)) {
    if (f.tile === tile && f.owner !== landId) return f;
  }
  let best = null;
  for (const s of Object.values(state.squads)) {
    if (s.land === landId || s.tile !== tile || s.status === 'routed' || s.troops <= 0) continue;
    if (!best || s.troops > best.troops) best = s;
  }
  return best;
}

function targetKey(target) {
  if (target.home) return `home:${target.home}`;
  return target.id;
}

function tileHostile(state, landId, tile) {
  for (const l of realLands(state)) if (l.id !== landId && l.alive !== false && l.home === tile) return true;
  for (const f of Object.values(state.forts)) if (f.tile === tile && f.owner !== landId) return true;
  for (const s of Object.values(state.squads)) if (s.land !== landId && s.tile === tile) return true;
  return false;
}

/** 体力減の地形に入ったときの兵の減り（mutates） */
function applyHpLoss(state, db, squad) {
  const terr = db.terrain[state.map.tiles[squad.tile].terrain];
  const loss = terr && terr.hpLoss;
  if (!loss || squad.troops <= 0) return;
  let rate = 0;
  if (loss === 'always') rate = HP_LOSS_ALWAYS;
  else if (loss === seasonOf(state.day)) rate = HP_LOSS_SEASONAL;
  if (!rate) return;
  squad.troops = Math.max(1, Math.floor(squad.troops * (1 - rate)));
}

/**
 * 実行フェーズ（mutates）。全イベントを 1 つずつ yield し、state.log にも積む。
 * 最後に finishDay（産出・建築・回復・霧・集計・終了判定）の分も yield する。
 * 途中で終了条件（Legendary の攻略・プレイヤーの本拠地の陥落）を満たしたら、そこで止めて season_end を出す。
 * @returns {Generator<object>}
 */
export function* execute(state, db, rng) {
  state.phase = 'execute';
  if (!state.log) state.log = [];
  const emit = (e) => {
    state.log.push(e);
    return e;
  };
  // 指示フェーズで queue が引いた AP を戻し、beginTurn が決めたこの日の AP から実費で引き直す。
  // ここで apMax を呼び直してはいけない：beginTurn が ambushed / routed をもう消しているので、
  // 奇襲された部隊（AP 半分）や敗走明けの部隊（AP 0）が満タンの AP で動いてしまう。
  for (const s of Object.values(state.squads)) {
    const hero = heroOf(db, s);
    let back = 0;
    for (const o of s.orders || []) back += typeof o.ap === 'number' ? o.ap : 0;
    const cap = hero ? apMax(hero, s, db) : 0;
    s.ap = Math.max(0, Math.min(cap, (s.ap || 0) + back));
  }
  const fought = new Set();
  // その日に落ちた砦は、その日のうちはもう攻められない（同じ日に持ち主が何度も入れ替わらないように）
  const fallenToday = new Set();
  const noteFallen = (events) => {
    for (const e of events) if (e.t === 'fort_fallen') fallenToday.add(e.fort);
  };

  // 1 歩ぶんの処理。出したイベントを配列で返す
  const contact = (squad, target, at, blocking) => {
    const out = [];
    const key = `${squad.id}|${targetKey(target)}`;
    if (squad.policy === 'ask') {
      squad.orders = [];
      out.push({ t: 'ask', squad: squad.id, at: squad.tile, enemy: target.home ? target.home : target.id });
      return out;
    }
    if (squad.policy === 'fight' && !fought.has(key) && !fallenToday.has(target.id) && inRange(state, db, squad, at)) {
      fought.add(key);
      const ev = resolve(state, db, rng, squad, target);
      out.push(ev, ...(ev.followups || []));
      noteFallen(out);
      if (blocking && squad.status !== 'routed' && tileHostile(state, squad.land, at)) squad.orders = [];
      return out;
    }
    if (blocking) {
      squad.orders = [];
      out.push({ t: 'blocked', squad: squad.id, at: squad.tile, reason: 'enemy' });
    }
    return out;
  };

  const step = (squad) => {
    const order = squad.orders[0];
    const hero = heroOf(db, squad);
    const id = squad.id;
    const land = state.lands[squad.land];
    const stop = (reason) => {
      squad.orders = [];
      return [{ t: 'blocked', squad: id, at: squad.tile, reason }];
    };
    const skip = (reason) => {
      squad.orders.shift();
      return [{ t: 'blocked', squad: id, at: squad.tile, reason }];
    };
    const pay = (cost) => {
      if (squad.ap < cost) return false;
      squad.ap -= cost;
      return true;
    };

    switch (order.type) {
      case 'move': {
        if (!Array.isArray(order.path) || order.path.length === 0) {
          squad.orders.shift();
          return [];
        }
        const next = order.path[0];
        const { w, h } = state.map;
        if (!neighbors(squad.tile, w, h).includes(next)) return stop('terrain');
        const cost = stepCost(state, db, squad, hero, next);
        if (!Number.isFinite(cost)) {
          const target = targetAt(state, squad.land, next);
          if (target) return contact(squad, target, next, true);
          return stop(tileHostile(state, squad.land, next) ? 'enemy' : 'terrain');
        }
        if (!pay(cost)) return stop('ap');
        const from = squad.tile;
        squad.tile = next;
        // path は呼ぶ側の配列を共有していることがあるので、書き換えずに作り直す
        const left = order.path.slice(1);
        squad.orders[0] = { ...order, path: left };
        applyHpLoss(state, db, squad);
        const out = [{ t: 'move', squad: id, from, to: next }];
        if (left.length === 0) {
          squad.orders.shift();
          return out;
        }
        // 途中で敵ランドの部隊と隣り合ったら接敵
        if (squad.policy !== 'ignore') {
          const near = new Set(neighbors(squad.tile, w, h));
          for (const o of Object.values(state.squads)) {
            if (o.land === squad.land || o.land === ENEMY_LAND || o.status === 'routed' || o.troops <= 0) continue;
            if (!near.has(o.tile)) continue;
            if (squad.policy === 'fight' && fought.has(`${id}|${o.id}`)) continue;
            out.push(...contact(squad, o, o.tile, false));
            break;
          }
        }
        return out;
      }
      case 'claim': {
        const tile = state.map.tiles[squad.tile];
        if (tile.owner === squad.land || tile.fort || tileHostile(state, squad.land, squad.tile)) return skip('claim');
        if (!pay(AP_COST.claim)) return stop('ap');
        tile.owner = squad.land;
        squad.orders.shift();
        return [{ t: 'claim', squad: id, tile: squad.tile, land: squad.land }];
      }
      case 'build': {
        const rush = Math.max(0, Math.floor(order.rush || 0));
        if (squad.ap < AP_COST.build) return stop('ap');
        const usedRush = Math.min(rush, Math.floor(squad.ap - AP_COST.build));
        const ev = startBuild(state, db, squad, order.kind, usedRush);
        squad.orders.shift();
        if (ev.t === 'build_start') squad.ap -= AP_COST.build + usedRush;
        return [ev];
      }
      case 'attack': {
        if (squad.ap < AP_COST.attack) return stop('ap');
        const target = targetAt(state, squad.land, order.target);
        if (!target || fallenToday.has(target.id)) return skip('target');
        if (!inRange(state, db, squad, order.target)) return skip('range');
        squad.ap -= AP_COST.attack;
        squad.orders.shift();
        const ev = resolve(state, db, rng, squad, target);
        const out = [ev, ...(ev.followups || [])];
        noteFallen(out);
        return out;
      }
      case 'domestic': {
        if (!land || land.home !== squad.tile) return skip('home');
        if (!pay(AP_COST.domestic)) return stop('ap');
        squad.orders.shift();
        return [domestic(state, db, squad, order.kind)];
      }
      case 'rest': {
        squad.orders.shift();
        squad.ap = 0;
        return [rest(state, db, squad)];
      }
      default:
        squad.orders.shift();
        return [];
    }
  };

  let ended = null;
  for (let round = 0; round < MAX_ROUNDS && !ended; round++) {
    const ids = Object.keys(state.squads).filter((id) => {
      const s = state.squads[id];
      return s.status !== 'routed' && s.orders && s.orders.length > 0;
    });
    if (ids.length === 0) break;
    for (const id of shuffle(rng, ids)) {
      const s = state.squads[id];
      if (!s || s.status === 'routed' || !s.orders || s.orders.length === 0) continue;
      const events = step(s);
      for (const e of events) yield emit(e);
      if (events.some((e) => e.t === 'clear' || e.t === 'home_fallen')) {
        const end = checkEnd(state, db);
        if (end) {
          ended = end;
          break;
        }
      }
    }
  }
  // 打ち切ったときに残った指示は捨てる
  for (const s of Object.values(state.squads)) s.orders = [];

  if (ended) {
    state.ended = ended;
    state.phase = 'ended';
    yield emit({ t: 'season_end', winner: ended.winner });
    return;
  }
  for (const e of finishDay(state, db)) yield emit(e);
}

/**
 * mutates。日の終わり：産出（applyDaily）→ 建築（tickBuilds）→ 回復 → 霧 → 日曜なら集計 →
 * day を進める → 終了判定。終わったら state.ended と phase "ended"（day は 28 に留める）。
 * 回復：support / healer の隣にいる同じランドの部隊は兵の上限 × healAdj、本拠地にいる部隊は +lead（上限まで）。
 * @returns {object[]} イベント
 */
export function finishDay(state, db) {
  const events = [];
  for (const land of realLands(state)) {
    if (land.alive === false) continue;
    events.push(...applyDaily(state, db, land.id));
  }
  events.push(...tickBuilds(state, db));

  // 回復
  const { w, h } = state.map;
  const squads = Object.values(state.squads).filter((s) => s.status !== 'routed');
  const heal = new Map();
  for (const s of squads) {
    const hero = heroOf(db, s);
    if (!hero) continue;
    const adj = subMods(hero.cls && hero.cls.sub).healAdj;
    if (adj > 0) {
      const near = new Set(neighbors(s.tile, w, h));
      for (const o of squads) {
        if (o.id === s.id || o.land !== s.land || !near.has(o.tile)) continue;
        const oh = heroOf(db, o);
        if (!oh) continue;
        heal.set(o.id, (heal.get(o.id) || 0) + Math.round(troopCap(oh, o, db) * adj));
      }
    }
    const land = state.lands[s.land];
    if (land && land.home === s.tile) {
      heal.set(s.id, (heal.get(s.id) || 0) + effectiveParams(hero, s, db).lead);
    }
  }
  for (const [id, n] of heal) {
    const s = state.squads[id];
    const cap = troopCap(heroOf(db, s), s, db);
    if (s.troops < cap) s.troops = Math.min(cap, s.troops + n);
  }

  for (const land of realLands(state)) if (land.alive !== false) revealFog(state, db, land.id);

  if (dayOfWeek(state.day) === 6) events.push(tallyWeek(state));

  state.day += 1;
  const end = checkEnd(state, db);
  if (end) {
    state.ended = end;
    state.phase = 'ended';
    state.day = Math.min(state.day, 28);
    events.push({ t: 'season_end', winner: end.winner });
  }
  return events;
}

/**
 * mutates。そのランドの探索済みタイルを広げる：全部隊の視界 + 本拠地の周囲 3 + 占領タイルの周囲 1。
 */
export function revealFog(state, db, landId) {
  const land = state.lands[landId];
  if (!land) return;
  const { w, h, tiles } = state.map;
  const seen = new Set(land.explored || []);
  const add = (list) => {
    for (const i of list) seen.add(i);
  };
  if (land.home != null) add(within(land.home, 3, w, h));
  for (const s of Object.values(state.squads)) {
    if (s.land !== landId) continue;
    const hero = heroOf(db, s);
    if (hero) add(within(s.tile, visionOf(hero, s, db), w, h));
  }
  for (let i = 0; i < tiles.length; i++) if (tiles[i].owner === landId) add(within(i, 1, w, h));
  land.explored = [...seen];
}

// ---------------------------------------------------------------- 通知

function landName(db, id) {
  if (id === ENEMY_LAND) return 'エネミー';
  const l = (db.lands || []).find((x) => x.id === id);
  return l ? l.nameJa || l.name : String(id);
}

function fortName(state, id) {
  const f = state.forts[id];
  return f ? f.name : String(id);
}

function targetName(state, db, ev) {
  if (ev.target === 'home') return `${landName(db, ev.defender)}の本拠地`;
  if (state.forts[ev.defender]) return fortName(state, ev.defender);
  const s = state.squads[ev.defender];
  const hero = s && heroOf(db, s);
  return hero ? hero.name : String(ev.defender);
}

/**
 * プレイヤーのランドに関係するイベントを、ホームの通知（日本語の短文）にする。
 * battle の followups は、execute が別のイベントとしても流すので、ここではトップレベルだけを見る。
 * @returns {object[]} Notice[]（id は state.notices の最大 + 1 から）
 */
export function noticesFrom(state, db, events) {
  const me = state.playerLand;
  const out = [];
  let nextId = 1;
  for (const n of state.notices || []) if (n.id >= nextId) nextId = n.id + 1;
  const day = state.day;
  const push = (kind, text, app = null, tile = null) => out.push({ id: nextId++, day, kind, text, app, tile });
  const mine = (squadId) => {
    const s = state.squads[squadId];
    return s && s.land === me ? s : null;
  };
  const heroFor = (s) => (s ? heroOf(db, s) : null);
  let claims = 0;

  for (const ev of events || []) {
    switch (ev.t) {
      case 'claim':
        if (ev.land === me) claims++;
        break;
      case 'blocked': {
        const s = mine(ev.squad);
        if (s) push('blocked', say(db, heroFor(s), 'report.blocked'), 'chat', ev.at);
        break;
      }
      case 'build_done':
        if (ev.land === me) push('build', say(db, null, 'report.build_done', { kind: uiText(db, `facility.${ev.kind}`) }), 'map', ev.tile);
        break;
      case 'domestic': {
        const s = mine(ev.squad);
        if (s) push('domestic', say(db, heroFor(s), 'report.domestic', { kind: uiText(db, `domestic.${ev.kind}`), n: ev.amount }), 'chat', null);
        break;
      }
      case 'battle': {
        const a = mine(ev.attacker);
        const name = targetName(state, db, ev);
        if (a) {
          const routedMe = (ev.followups || []).some((f) => f.t === 'routed' && f.squad === ev.attacker);
          let id = null;
          if (routedMe) id = 'report.lose';
          else if (ev.result === 'fort_fallen') id = 'report.fort';
          else if (ev.ambush && !ev.evaded) id = 'report.ambushed_them';
          else if (!ev.evaded) id = 'report.win';
          if (id) push('battle', say(db, heroFor(a), id, { target: name }), 'map', ev.at);
        } else {
          const d = ev.target !== 'home' ? mine(ev.defender) : null;
          if (d && ev.ambush) push('battle', say(db, heroFor(d), 'report.ambush'), 'map', ev.at);
          else if (ev.target === 'home' && ev.defender === me) push('battle', `${landName(db, state.squads[ev.attacker] ? state.squads[ev.attacker].land : '')}が本拠地を攻めてきました`, 'map', ev.at);
        }
        break;
      }
      case 'routed': {
        const s = mine(ev.squad);
        if (s) push('routed', say(db, heroFor(s), 'report.routed'), 'chat', ev.home);
        break;
      }
      case 'fort_fallen':
        if (ev.from === me) push('fort', `${fortName(state, ev.fort)}を${landName(db, ev.by)}に奪われました`, 'map', state.forts[ev.fort] ? state.forts[ev.fort].tile : null);
        else if (ev.by !== me) push('fort', `${landName(db, ev.by)}が${fortName(state, ev.fort)}を落としました`, 'map', state.forts[ev.fort] ? state.forts[ev.fort].tile : null);
        break;
      case 'home_fallen':
        if (ev.land === me) push('home', `本拠地が${landName(db, ev.by)}に落とされました`, null, null);
        else if (ev.by === me) push('home', `${landName(db, ev.land)}の本拠地を落としました。ヒーロー ${ev.heroes.length} 体が仲間に加わります`, 'drive', null);
        else push('home', `${landName(db, ev.by)}が${landName(db, ev.land)}の本拠地を落としました`, 'map', null);
        break;
      case 'soul':
        if (ev.land === me) push('soul', 'SOUL を手に入れました。Drive で仲間にするヒーローを選べます', 'drive', null);
        break;
      case 'extension_offer':
        if (ev.land === me) push('extension', 'エクステンションの報酬があります。Photo で選べます', 'photo', null);
        break;
      case 'ask': {
        const s = mine(ev.squad);
        if (s) push('ask', say(db, heroFor(s), 'report.ask'), 'chat', ev.at);
        break;
      }
      case 'starve':
        if (ev.land === me) push('starve', '食料が足りません。兵と人口が減りました', 'drive', null);
        break;
      case 'week_end': {
        const p = (ev.points || {})[me] || 0;
        push('week', `第${ev.week}週の集計：砦ポイント +${p}`, 'calendar', null);
        break;
      }
      case 'clear':
        push('clear', ev.land === me ? 'Legendary 砦を攻略しました' : `${landName(db, ev.land)}が Legendary 砦を攻略しました`, null, null);
        break;
      case 'season_end':
        push('end', ev.winner ? `シーズン終了。勝者は${landName(db, ev.winner)}` : 'シーズン終了', null, null);
        break;
      default:
        break;
    }
  }
  if (claims > 0) push('claim', `${claims} タイルを占領しました`, 'map', null);
  return out;
}

