// hex.js のテスト（odd-r・pointy-top・東西ループ）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  idx, col, row, wrapC, neighbors, distance, ring, within, latitude, toPixel, fromPixel,
} from '../js/engine/hex.js';

const W = 48, H = 28;

test('wrapC は負の数も 1 周超えも 0..w-1 に折り返す', () => {
  assert.equal(wrapC(0, W), 0);
  assert.equal(wrapC(-1, W), 47);
  assert.equal(wrapC(48, W), 0);
  assert.equal(wrapC(49, W), 1);
  assert.equal(wrapC(-49, W), 47);
});

test('idx / col / row は往復する（idx は c を折り返す）', () => {
  for (let r = 0; r < H; r += 5) {
    for (let c = 0; c < W; c += 7) {
      const i = idx(c, r, W);
      assert.equal(col(i, W), c);
      assert.equal(row(i, W), r);
    }
  }
  assert.equal(idx(-1, 3, W), idx(47, 3, W));
  assert.equal(idx(48, 3, W), idx(0, 3, W));
});

test('neighbors は内側で 6、南北の端で欠け、東西はループする', () => {
  assert.equal(neighbors(idx(10, 10, W), W, H).length, 6);
  assert.equal(neighbors(idx(10, 0, W), W, H).length, 4);      // 偶数行の北端
  assert.equal(neighbors(idx(10, H - 1, W), W, H).length, 4);  // 奇数行の南端（27 は奇数）
  // 西端 c=0 の隣に c=47 がある
  const west = neighbors(idx(0, 10, W), W, H).map(i => col(i, W));
  assert.ok(west.includes(47));
  // 東端 c=47 の奇数行の隣に c=0 がある（奇数行は右上・右下が c+1）
  const east = neighbors(idx(47, 11, W), W, H).map(i => col(i, W));
  assert.ok(east.includes(0));
  assert.equal(east.filter(c => c === 0).length, 3); // 右・右上・右下
});

test('neighbors は対称（i の隣が j なら j の隣が i）', () => {
  for (let i = 0; i < W * H; i++) {
    for (const j of neighbors(i, W, H)) {
      assert.ok(neighbors(j, W, H).includes(i), `${i} ↔ ${j}`);
    }
  }
});

test('neighbors は 6 方向が全部ちがうタイル', () => {
  for (let i = 0; i < W * H; i++) {
    const ns = neighbors(i, W, H);
    assert.equal(new Set(ns).size, ns.length);
    assert.ok(!ns.includes(i));
  }
});

// 幅のループと南北の端を正しく扱う BFS（検算用）
function bfsDistance(a, b, w, h) {
  const seen = new Map([[a, 0]]);
  const q = [a];
  while (q.length) {
    const cur = q.shift();
    if (cur === b) return seen.get(cur);
    for (const n of neighbors(cur, w, h)) {
      if (!seen.has(n)) { seen.set(n, seen.get(cur) + 1); q.push(n); }
    }
  }
  return Infinity;
}

test('distance は隣で 1・自分で 0・ループを考えた最短', () => {
  assert.equal(distance(idx(5, 5, W), idx(5, 5, W), W, H), 0);
  for (const n of neighbors(idx(5, 5, W), W, H)) assert.equal(distance(idx(5, 5, W), n, W, H), 1);
  assert.equal(distance(idx(0, 5, W), idx(47, 5, W), W, H), 1);
  assert.equal(distance(idx(1, 5, W), idx(47, 5, W), W, H), 2);
  assert.equal(distance(idx(0, 5, W), idx(24, 5, W), W, H), 24);   // 裏側
  assert.equal(distance(idx(0, 5, W), idx(25, 5, W), W, H), 23);   // 裏側から 1 つ戻る
  assert.equal(distance(idx(0, 0, W), idx(0, 27, W), W, H), 27);   // 北極から南極
});

test('distance は対称で、BFS の距離と一致する', () => {
  // 決定的な疑似乱数（Math.random は使わない）
  let s = 12345;
  const next = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s; };
  for (let k = 0; k < 200; k++) {
    const a = next() % (W * H);
    const b = next() % (W * H);
    const d = distance(a, b, W, H);
    assert.equal(d, distance(b, a, W, H));
    assert.equal(d, bfsDistance(a, b, W, H), `a=${a} b=${b}`);
  }
});

test('distance は三角不等式を満たす', () => {
  let s = 777;
  const next = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s; };
  for (let k = 0; k < 200; k++) {
    const a = next() % (W * H), b = next() % (W * H), c = next() % (W * H);
    assert.ok(distance(a, c, W, H) <= distance(a, b, W, H) + distance(b, c, W, H));
  }
});

test('within / ring の大きさ（内側は 1 + 3r(r+1)、端では欠ける）', () => {
  const i = idx(20, 14, W);
  assert.deepEqual(within(i, 0, W, H), [i]);
  assert.equal(within(i, 1, W, H).length, 7);
  assert.equal(within(i, 2, W, H).length, 19);
  assert.equal(within(i, 3, W, H).length, 37);
  assert.equal(ring(i, 1, W, H).length, 6);
  assert.equal(ring(i, 2, W, H).length, 12);
  assert.equal(ring(i, 3, W, H).length, 18);
  assert.deepEqual(ring(i, 0, W, H), [i]);
  // ring の中身はちょうどその距離
  for (const j of ring(i, 3, W, H)) assert.equal(distance(i, j, W, H), 3);
  for (const j of within(i, 3, W, H)) assert.ok(distance(i, j, W, H) <= 3);
  // 北極の端では欠ける
  assert.ok(within(idx(20, 0, W), 2, W, H).length < 19);
  // 東西の端ではループして欠けない
  assert.equal(within(idx(0, 14, W), 2, W, H).length, 19);
  assert.equal(within(idx(47, 14, W), 2, W, H).length, 19);
});

test('latitude は北が正で、赤道をはさんで対称', () => {
  assert.ok(Math.abs(latitude(0, H) - 86.786) < 0.01);
  assert.ok(Math.abs(latitude(27, H) + 86.786) < 0.01);
  for (let r = 0; r < H; r++) assert.ok(Math.abs(latitude(r, H) + latitude(H - 1 - r, H)) < 1e-9);
  assert.ok(latitude(13, H) > 0 && latitude(14, H) < 0);
});

test('toPixel / fromPixel は往復する（pointy-top・奇数行は半分ずれる）', () => {
  const size = 28;
  const p0 = toPixel(0, 0, size);
  assert.deepEqual(p0, { x: 0, y: 0 });
  const p1 = toPixel(0, 1, size);
  assert.ok(Math.abs(p1.x - size * Math.sqrt(3) / 2) < 1e-9);  // 奇数行は右に半ヘックス
  assert.ok(Math.abs(p1.y - size * 1.5) < 1e-9);
  for (let r = 0; r < 12; r++) {
    for (let c = 0; c < 12; c++) {
      const p = toPixel(c, r, size);
      assert.deepEqual(fromPixel(p.x, p.y, size), { c, r });
      // 中心から少しずれても同じタイル
      assert.deepEqual(fromPixel(p.x + size * 0.3, p.y - size * 0.2, size), { c, r });
    }
  }
});
