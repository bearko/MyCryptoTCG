// 乱数（mulberry32）。engine の中で Math.random は使わず、必ずここで作った rng を引数で回す。
// 同じ seed なら同じ列が出るので、テストと再現（セーブからの続き）が成り立つ。

/**
 * mulberry32 の乱数生成器を作る。
 * @param {number} seed 整数（小数は切り捨て。負や 2^32 以上は 32bit に丸める）
 * @returns {() => number} 0 以上 1 未満
 */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * lo 以上 hi 以下の整数。
 * @param {() => number} rng
 * @param {number} lo
 * @param {number} hi
 */
export function rngInt(rng, lo, hi) {
  if (hi < lo) [lo, hi] = [hi, lo];
  return lo + Math.floor(rng() * (hi - lo + 1));
}

/**
 * 配列から 1 つ選ぶ。空なら undefined。
 * @template T
 * @param {() => number} rng
 * @param {T[]} arr
 * @returns {T|undefined}
 */
export function pick(rng, arr) {
  if (!arr || arr.length === 0) return undefined;
  return arr[Math.floor(rng() * arr.length)];
}

/**
 * Fisher–Yates。元の配列は変えず、新しい配列を返す。
 * @template T
 * @param {() => number} rng
 * @param {T[]} arr
 * @returns {T[]}
 */
export function shuffle(rng, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = a[i];
    a[i] = a[j];
    a[j] = tmp;
  }
  return a;
}

/**
 * 文字列から 32bit の符号なし整数（FNV-1a）。seed づくりに使う。
 * @param {string} s
 * @returns {number} 0 以上 2^32 未満
 */
export function hashStr(s) {
  let h = 0x811c9dc5;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
