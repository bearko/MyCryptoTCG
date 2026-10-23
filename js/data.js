// data.js — data/*.json の読み込みと索引（db）
//
// 契約：docs/specs/SPEC-110-engine-contract.md §2 の db
//   db = { terrain: {id: Terrain}, facilities: {id: Facility}, lands: Land定義[],
//          heroes: {id: Hero}, heroList: Hero[], enemies: Enemy[],
//          extensions: {id: Ext}, messages: Messages }
// ブラウザは loadDb()（fetch）、Node のテストと tools/sim.mjs は loadDbFromFs(dir)。
// node:fs は loadDbFromFs の中で動的に import するので、ブラウザでは読み込まれない。

export const DATA_FILES = ['terrain', 'facilities', 'lands', 'heroes', 'enemies', 'extensions', 'messages'];

function byId(list) {
  const out = {};
  for (const x of list || []) out[x.id] = x;
  return out;
}

/** 読み込んだ JSON（ファイル名 → 中身）から db を組み立てる */
export function buildDb(raw) {
  const heroList = raw.heroes || [];
  return {
    terrain: byId(raw.terrain),
    facilities: byId(raw.facilities),
    lands: raw.lands || [],
    heroes: byId(heroList),
    heroList,
    enemies: raw.enemies || [],
    extensions: byId(raw.extensions),
    messages: raw.messages || { tones: [], messages: {}, ui: {} },
  };
}

/**
 * ブラウザ用。base は data/ の URL（既定は "./data/"）。
 * @returns {Promise<object>} db
 */
export async function loadDb(base = './data/') {
  const root = base.endsWith('/') ? base : base + '/';
  const entries = await Promise.all(
    DATA_FILES.map(async (name) => {
      const res = await fetch(`${root}${name}.json`);
      if (!res.ok) throw new Error(`data/${name}.json を読めない（${res.status}）`);
      return [name, await res.json()];
    })
  );
  return buildDb(Object.fromEntries(entries));
}

/**
 * Node 用。dir は data/ のパス（既定はこのファイルから見た ../data）。
 * @returns {Promise<object>} db
 */
export async function loadDbFromFs(dir) {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const url = await import('node:url');
  const root = dir || path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'data');
  const raw = {};
  for (const name of DATA_FILES) {
    raw[name] = JSON.parse(await fs.readFile(path.join(root, `${name}.json`), 'utf8'));
  }
  return buildDb(raw);
}
