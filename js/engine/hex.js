// hex.js — odd-r オフセット座標・pointy-top のヘックス（東西ループ）
//
// タイルの index は r * w + c。c は 0..w-1 でループする（円筒）。r は 0..h-1 で、南北の端は欠ける。
// 契約：docs/specs/SPEC-110-engine-contract.md §3 `hex.js`。DOM に触れない純粋関数だけ。
//
// 東西ループは幅 w が偶数のときだけ odd-r の行の偶奇と矛盾しない（w = 48）。

const SQRT3 = Math.sqrt(3);

export function idx(c, r, w) {
  return r * w + wrapC(c, w);
}

export function col(i, w) {
  return i % w;
}

export function row(i, w) {
  return Math.floor(i / w);
}

/** c を 0..w-1 に折り返す（負の数も可） */
export function wrapC(c, w) {
  return ((c % w) + w) % w;
}

// odd-r の隣接オフセット（[dc, dr]）。偶数行と奇数行で違う
const EVEN = [[1, 0], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1]];
const ODD = [[1, 0], [1, -1], [0, -1], [-1, 0], [0, 1], [1, 1]];

/** 隣接 6 タイルの index。南北の端で欠け、東西はループする */
export function neighbors(i, w, h) {
  const c = col(i, w);
  const r = row(i, w);
  const offs = (r & 1) ? ODD : EVEN;
  const out = [];
  for (const [dc, dr] of offs) {
    const nr = r + dr;
    if (nr < 0 || nr >= h) continue;
    out.push(nr * w + wrapC(c + dc, w));
  }
  return out;
}

/** odd-r → cube（x, z。y = -x - z） */
function toCube(c, r) {
  const x = c - ((r - (r & 1)) >> 1);
  return { x, z: r };
}

function cubeDist(ax, az, bx, bz) {
  const dx = ax - bx;
  const dz = az - bz;
  const dy = -dx - dz;
  return Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
}

/** 東西ループを考えた最短距離 */
export function distance(a, b, w, h) {
  const ca = col(a, w), ra = row(a, w);
  const cb = col(b, w), rb = row(b, w);
  const A = toCube(ca, ra);
  const B = toCube(cb, rb);
  // 相手を 1 周ぶん左右にずらした 3 通りの最小。w が偶数なら c を w ずらしても行の偶奇は変わらない
  let best = Infinity;
  for (const k of [-1, 0, 1]) {
    const d = cubeDist(A.x, A.z, B.x + k * w, B.z);
    if (d < best) best = d;
  }
  return best;
}

/** 距離 radius 以内のタイル（自分を含む）。BFS なので南北の端は欠ける */
export function within(i, radius, w, h) {
  const seen = new Map([[i, 0]]);
  let frontier = [i];
  for (let d = 1; d <= radius; d++) {
    const next = [];
    for (const cur of frontier) {
      for (const n of neighbors(cur, w, h)) {
        if (seen.has(n)) continue;
        seen.set(n, d);
        next.push(n);
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return [...seen.keys()];
}

/** 距離がちょうど radius のタイル */
export function ring(i, radius, w, h) {
  if (radius === 0) return [i];
  const seen = new Set([i]);
  let frontier = [i];
  for (let d = 1; d <= radius; d++) {
    const next = [];
    for (const cur of frontier) {
      for (const n of neighbors(cur, w, h)) {
        if (seen.has(n)) continue;
        seen.add(n);
        next.push(n);
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return frontier;
}

/** 行 r の緯度（度。北が正）。spec §3：90 − (r + 0.5) × 180 / h */
export function latitude(r, h) {
  return 90 - (r + 0.5) * 180 / h;
}

/** 描画用（pointy-top）。奇数行は半ヘックス右にずれる。ループは UI が処理する */
export function toPixel(c, r, size) {
  const x = size * SQRT3 * (c + 0.5 * (r & 1));
  const y = size * 1.5 * r;
  return { x, y };
}

/** toPixel の逆。ヘックスの中心からのずれを丸めて最も近いタイルを返す */
export function fromPixel(x, y, size) {
  // 軸座標（axial）の小数値
  const q = (SQRT3 / 3 * x - 1 / 3 * y) / size;
  const r = (2 / 3 * y) / size;
  // cube で丸める
  let rx = Math.round(q);
  let rz = Math.round(r);
  let ry = Math.round(-q - r);
  const dx = Math.abs(rx - q);
  const dy = Math.abs(ry - (-q - r));
  const dz = Math.abs(rz - r);
  if (dx > dy && dx > dz) rx = -ry - rz;
  else if (dy > dz) ry = -rx - rz;
  else rz = -rx - ry;
  // cube → odd-r
  const rr = rz + 0;                           // -0 を 0 に
  const cc = rx + ((rr - (rr & 1)) >> 1) + 0;
  return { c: cc, r: rr };
}
