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
        troops: hero.params.lead * 3,
        ap: 0,
        orders: [],
        policy: land.cpu ? 'fight' : 'ask',
        status: 'ok',
        equip: null,
        ambushed: false,
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

export function deserialize(json) {
  const s = typeof json === 'string' ? JSON.parse(json) : json;
  if (!s || s.version !== STATE_VERSION || !s.map || !s.lands || !s.squads) {
    throw new Error('セーブデータの形が違う');
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
