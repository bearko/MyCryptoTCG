// season.js — 暦（週・季節・曜日）、砦ポイントの集計、終了判定、スコア、バッテリー
//
// 契約：docs/specs/SPEC-110-engine-contract.md §3 `season.js`
// 数値：docs/specs/SPEC-109-mycryptowars-mvp.md §1・§2・§11
// DOM に触れない純粋関数。state を書き換えるのは tallyWeek だけ。

export const SEASON_DAYS = 28;
export const ENEMY_LAND = 'enemy';

const SEASONS = ['spring', 'summer', 'autumn', 'winter'];
const FORT_POINTS = { rare: 1, epic: 3, legendary: 10 };

/** 1..4（29 日目以降も 4） */
export function weekOf(day) {
  return Math.min(4, Math.max(1, Math.ceil(day / 7)));
}

/** 第 1 週＝春、第 2 週＝夏、第 3 週＝秋、第 4 週＝冬 */
export function seasonOf(day) {
  return SEASONS[weekOf(day) - 1];
}

/** 0 が月曜、6 が日曜（1 日目は月曜） */
export function dayOfWeek(day) {
  return (((day - 1) % 7) + 7) % 7;
}

/** Rare 1 / Epic 3 / Legendary 10 */
export function fortPoints(rank) {
  return FORT_POINTS[rank] || 0;
}

/** プレイヤーと CPU のランド id（"enemy" を除く） */
function realLandIds(state) {
  return Object.keys(state.lands).filter((id) => id !== ENEMY_LAND);
}

/**
 * mutates。その日の週について、砦を持っているランドに砦ポイントを入れる。
 * land.fortPoints（累計）と land.points.weekN（その週のぶん）に足す。
 * @returns {{t:"week_end", week:number, points:Object<string,number>}} points はこの週に入ったぶん（全ランド）
 */
export function tallyWeek(state) {
  const week = weekOf(state.day);
  const key = `week${week}`;
  const points = {};
  for (const id of realLandIds(state)) points[id] = 0;
  for (const f of Object.values(state.forts)) {
    if (!f || f.owner === ENEMY_LAND || !(f.owner in points)) continue;
    points[f.owner] += fortPoints(f.rank);
  }
  for (const id of Object.keys(points)) {
    const land = state.lands[id];
    if (!land.points) land.points = { week1: 0, week2: 0, week3: 0, week4: 0 };
    land.points[key] = (land.points[key] || 0) + points[id];
    land.fortPoints = (land.fortPoints || 0) + points[id];
  }
  return { t: 'week_end', week, points };
}

/** そのランドの占領タイル数 */
export function tileCount(state, landId) {
  let n = 0;
  for (const t of state.map.tiles) if (t.owner === landId) n++;
  return n;
}

/**
 * 終了判定。state.ended が付いていればそれを返す（ギブアップもここで拾える）。
 * 1. Legendary 砦をランドが持った → { reason: "clear", winner: そのランド }
 * 2. プレイヤーの本拠地が落ちた（alive=false）→ { reason: "home_fallen", winner: null }
 * 3. 28 日目の集計が済んだ（turn.finishDay が day を 29 に進めた）→ { reason: "season", winner: 最多砦ポイント（同点は占領数）}
 * @returns {null | {reason:string, winner:string|null}}
 */
export function checkEnd(state, db) {
  void db;
  if (state.ended) return state.ended;
  for (const f of Object.values(state.forts)) {
    if (f && f.rank === 'legendary' && f.owner !== ENEMY_LAND && state.lands[f.owner]) {
      return { reason: 'clear', winner: f.owner };
    }
  }
  const me = state.lands[state.playerLand];
  if (me && me.alive === false) return { reason: 'home_fallen', winner: null };
  if (state.day > SEASON_DAYS) return { reason: 'season', winner: seasonWinner(state) };
  return null;
}

/** 最多砦ポイント → 同点なら占領数 → それでも同点なら null */
export function seasonWinner(state) {
  let best = null;
  let tie = false;
  for (const id of realLandIds(state)) {
    const land = state.lands[id];
    if (land.alive === false) continue;
    const key = [land.fortPoints || 0, tileCount(state, id)];
    if (!best || key[0] > best.key[0] || (key[0] === best.key[0] && key[1] > best.key[1])) {
      best = { id, key };
      tie = false;
    } else if (key[0] === best.key[0] && key[1] === best.key[1]) {
      tie = true;
    }
  }
  return best && !tie ? best.id : null;
}

/**
 * スコア（spec §11）。breakdown は各項目の点（足すと total）。counts は元の数。
 * clear と daysLeft は、そのランドが Legendary を攻略して終わったときだけ。
 */
export function score(state, db, landId) {
  void db;
  const land = state.lands[landId];
  const fp = land ? land.fortPoints || 0 : 0;
  const tiles = tileCount(state, landId);
  let heroes = 0;
  for (const s of Object.values(state.squads)) if (s.land === landId) heroes++;
  let ranks = 0;
  for (const t of state.map.tiles) if (t.owner === landId && t.facility) ranks += t.facility.rank || 1;
  const cleared = !!(state.ended && state.ended.reason === 'clear' && state.ended.winner === landId);
  const daysLeft = cleared ? Math.max(0, SEASON_DAYS - state.day) : 0;
  const breakdown = {
    fortPoints: fp * 100,
    tiles: tiles * 5,
    heroes: heroes * 50,
    facilities: ranks * 20,
    clear: cleared ? 2000 : 0,
    daysLeft: daysLeft * 30,
  };
  const total = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return { total, breakdown, counts: { fortPoints: fp, tiles, heroes, facilityRanks: ranks, daysLeft } };
}

/** 残り日数（その日を含む）÷ 28 を 0..100 の整数。1 日目 100、28 日目 4、29 日目 0 */
export function battery(day) {
  const left = Math.min(SEASON_DAYS, Math.max(0, SEASON_DAYS + 1 - day));
  return Math.round((left / SEASON_DAYS) * 100);
}
