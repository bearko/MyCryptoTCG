// ============================================================
// data-loader.js — JSON ローダパターン (= 重複 fetch を防ぐ)
// ============================================================

const _promises = new Map();
const _cache = new Map();

/**
 * JSON を一度だけ fetch し、 以降は cache から返す
 * @param {string} key - cache key (= 通常はファイル path)
 * @param {string} url - fetch URL
 * @param {(json: any) => any} [transform] - 任意の整形関数
 * @returns {Promise<any>}
 */
export function loadJson(key, url, transform) {
  if (_cache.has(key)) return Promise.resolve(_cache.get(key));
  if (_promises.has(key)) return _promises.get(key);

  const p = fetch(url)
    .then((r) => {
      if (!r.ok) throw new Error(`fetch failed: ${url} (${r.status})`);
      return r.json();
    })
    .then((data) => {
      const out = typeof transform === "function" ? transform(data) : data;
      _cache.set(key, out);
      return out;
    })
    .catch((err) => {
      _promises.delete(key);
      console.error(`loadJson(${key})`, err);
      throw err;
    });

  _promises.set(key, p);
  return p;
}

/**
 * cache を全部消す (= テスト用)
 */
export function clearJsonCache() {
  _promises.clear();
  _cache.clear();
}
