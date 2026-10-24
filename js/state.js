// state.js — 新しいゲーム・保存と読み込み
//
// 契約：docs/specs/SPEC-110-engine-contract.md §2・§3 `state.js`
// state は JSON にそのまま保存できる形（Set / Map を持たない）。
// localStorage を触ってよいのはこのファイルだけ（engine からは呼ばない）。

import { LS_SAVE } from './constants.js';
import { makeRng, hashStr } from './engine/rng.js';
import { generateWorld } from './engine/worldgen.js';
import { starterHeroes } from './engine/heroes.js';
import { beginTurn, revealFog } from './engine/turn.js';
import { startTroops } from './engine/tuning.js';
import { MORALE_START, DEFAULT_RATION, RATIONS, clampMorale } from './engine/morale.js';

export const STATE_VERSION = 1;
export const ENEMY_LAND = 'enemy';
export const INITIAL_RES = { pop: 100, food: 150, gum: 120, mat: 60 };

function newLand(id, cpu, home) {
  return {
    id,
    cpu,
    alive: true,
    home,
    res: { ...INITIAL_RES },
    explored: [],
    souls: [],
    extensions: [],
    fortPoints: 0,
    points: { week1: 0, week2: 0, week3: 0, week4: 0 },
    ration: DEFAULT_RATION,
  };
}

/**
 * 新しいゲーム。worldgen → 9 ランド + "enemy" → 開始時のヒーロー 3 体ずつ → 砦 → 霧 → beginTurn。
 * @param {{seed:number, playerLand:string, db:object}} opts
 * @returns {object} state
 */
export function newGame({ seed, playerLand, db }) {
  const landIds = db.lands.map((l) => l.id);
  if (!landIds.includes(playerLand)) throw new Error(`unknown land: ${playerLand}`);
  const world = generateWorld(seed, db, landIds);

  const state = {
    version: STATE_VERSION,
    seed,
    day: 1,
    phase: 'orders',
    playerLand,
    map: world.map,
    lands: {},
    squads: {},
    forts: {},
    builds: {},
    nextId: 1,
    log: [],
    notices: [],
    pending: [],
    ended: null,
  };

  for (const id of landIds) state.lands[id] = newLand(id, id !== playerLand, world.homes[id]);
  // エネミー（砦の持ち主）。本拠地は無く、資源も使わない
  const enemy = newLand(ENEMY_LAND, true, null);
  enemy.res = { pop: 0, food: 0, gum: 0, mat: 0 };
  state.lands[ENEMY_LAND] = enemy;

  const rng = makeRng(hashStr(`starters:${seed}`));
  const used = new Set();
  landIds.forEach((landId, i) => {
    const land = state.lands[landId];
    for (const heroId of starterHeroes(rng, db, i, used)) {
      const hero = db.heroes[heroId];
      const id = 's' + state.nextId++;
      state.squads[id] = {
        id,
        heroId,
        land: landId,
        tile: land.home,
        troops: startTroops(hero.params.lead),
        mustered: startTroops(hero.params.lead),
        ap: 0,
        orders: [],
        policy: land.cpu ? 'fight' : 'ask',
        status: 'ok',
        equip: null,
        ambushed: false,
        morale: MORALE_START,
      };
    }
  });

  for (const f of world.forts) state.forts[f.id] = f;
  for (const id of landIds) revealFog(state, db, id);
  beginTurn(state, db);
  return state;
}

export function serialize(state) {
  return JSON.stringify(state);
}

/**
 * 読み込み。SPEC-113 より前のセーブには Squad.morale / Land.ration が無いので、既定値（60 / "normal"）を入れる
 * （保存の形は変わったが、古いセーブを捨てない。SPEC-113 §6.4）。
 */
export function deserialize(json) {
  const s = typeof json === 'string' ? JSON.parse(json) : json;
  if (!s || s.version !== STATE_VERSION || !s.map || !s.lands || !s.squads) {
    throw new Error('セーブデータの形が違う');
  }
  return withDefaults(s);
}

/**
 * mutates。morale / ration の欠けを既定値で埋める（古いセーブ・テストで手書きした state 用）。
 * 範囲の外・小数の士気（手で書き換えたセーブなど）は 0〜100 の整数に切る。そのままだと、
 * 夜の処理で切られるまでの 1 日、表示と戦闘の係数が食い違う。
 */
export function withDefaults(s) {
  for (const sq of Object.values(s.squads)) {
    if (typeof sq.morale !== 'number' || !Number.isFinite(sq.morale)) sq.morale = MORALE_START;
    else sq.morale = clampMorale(sq.morale);
    if (typeof sq.mustered !== 'number' || !Number.isFinite(sq.mustered)) sq.mustered = Math.max(0, sq.troops || 0);
  }
  for (const l of Object.values(s.lands)) {
    if (!RATIONS[l.ration]) l.ration = DEFAULT_RATION;
  }
  return s;
}

function storage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** localStorage の mcw.save に保存。localStorage が無ければ何もしない */
export function save(state) {
  const ls = storage();
  if (!ls) return false;
  try {
    ls.setItem(LS_SAVE, serialize(state));
    return true;
  } catch {
    return false;
  }
}

/** 保存があれば state、無い・壊れていれば null */
export function load() {
  const ls = storage();
  if (!ls) return null;
  try {
    const raw = ls.getItem(LS_SAVE);
    return raw ? deserialize(raw) : null;
  } catch {
    return null;
  }
}

export function clearSave() {
  const ls = storage();
  if (!ls) return;
  try {
    ls.removeItem(LS_SAVE);
  } catch {
    /* 何もしない */
  }
}
