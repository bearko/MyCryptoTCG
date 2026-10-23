// ambient.js — 常時の背景（SPEC-112 §1 D「止まらない画面」）
//
// 端末（.phone）の一番奥に canvas を 1 枚だけ置き、ランドの色のゆっくりした光の帯・浮かぶ粒子・
// 薄いヘックスの格子・走査線を描く。UI はこの上に乗る（UI のほうが彩度が高い）。
// - 30fps 上限。端末の解像度は 1 倍で描く（ぼかしの絵なので十分）
// - タブが隠れた・画面外・地図のように全面を覆うアプリの間は止める
// - 動きを減らす（OS / 設定）なら 1 枚だけ描いて止める
// ゲームのルールはここに書かない。

import { reducedMotion, onMotionChange } from './fx.js';

const FPS = 30;
const FRAME_MS = 1000 / FPS;
const PARTICLES = 26;
/** 画面全体を自前で塗るので、背景を描かなくてよいアプリ */
const COVERED_APPS = new Set(['map']);

let canvas = null;
let ctx = null;
let host = null;
let raf = 0;
let last = 0;
let t = 0;
let w = 0;
let hgt = 0;
let visible = true;
let covered = false;
let lattice = null;
let particles = [];
let color = [196, 163, 90];
let target = [196, 163, 90];
let intensity = 1;
let pulseUntil = 0;
let latticeAt = 0;

function parseColor(c) {
  if (!c) return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(String(c).trim());
  if (m) {
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const r = /rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)/.exec(String(c));
  return r ? [Number(r[1]), Number(r[2]), Number(r[3])] : null;
}

const rgba = (c, a) => `rgba(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0}, ${a})`;

/** 決まった種の小さな乱数（描くたびに同じ並び。ゲームの乱数とは別） */
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = s;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function makeParticles() {
  const r = seeded(7);
  particles = [];
  for (let i = 0; i < PARTICLES; i++) {
    particles.push({
      x: r(), y: r(), z: 0.3 + r() * 0.7,
      sp: 0.006 + r() * 0.014, drift: (r() - 0.5) * 0.01,
      ph: r() * Math.PI * 2, size: 0.8 + r() * 1.8,
    });
  }
}

/** ヘックスの格子と走査線（色が変わったとき・大きさが変わったときだけ作り直す） */
function makeLattice() {
  if (!w || !hgt) return;
  const off = document.createElement('canvas');
  off.width = w;
  off.height = hgt;
  const g = off.getContext('2d');
  // ヘックス（上側に薄く。下へ行くほど消える）
  const s = 22;
  const hw = Math.sqrt(3) * s;
  g.lineWidth = 1;
  for (let row = -1; row * s * 1.5 < hgt * 0.75; row++) {
    const y = row * s * 1.5;
    const fade = Math.max(0, 1 - y / (hgt * 0.7));
    g.strokeStyle = rgba(color, 0.07 * fade);
    for (let col = -1; col * hw < w + hw; col++) {
      const x = col * hw + (row & 1 ? hw / 2 : 0);
      g.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = (Math.PI / 3) * k + Math.PI / 6;
        const px = x + s * Math.cos(a);
        const py = y + s * Math.sin(a);
        if (k) g.lineTo(px, py); else g.moveTo(px, py);
      }
      g.closePath();
      g.stroke();
    }
  }
  // 走査線
  g.fillStyle = 'rgba(255, 255, 255, 0.018)';
  for (let y = 0; y < hgt; y += 3) g.fillRect(0, y, w, 1);
  lattice = off;
}

function resize() {
  if (!canvas || !host) return;
  const nw = Math.max(1, Math.round(host.clientWidth));
  const nh = Math.max(1, Math.round(host.clientHeight));
  if (nw === w && nh === hgt) return;
  w = nw;
  hgt = nh;
  canvas.width = w;
  canvas.height = hgt;
  makeLattice();
  draw(t);
}

function draw(time) {
  if (!ctx || !w) return;
  const c = color;
  const k = intensity * (time < pulseUntil ? 1 + 0.8 * ((pulseUntil - time) / 900) : 1);
  ctx.globalCompositeOperation = 'source-over';
  // 奥の色（真っ黒ではなく、ランドの色が少し混ざった夜）
  const bg = ctx.createLinearGradient(0, 0, 0, hgt);
  bg.addColorStop(0, `rgb(${18 + c[0] * 0.06 | 0}, ${15 + c[1] * 0.05 | 0}, ${26 + c[2] * 0.06 | 0})`);
  bg.addColorStop(1, '#0c0a11');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, hgt);
  // 上からの光だまり（ゆっくり左右に揺れる）
  const sec = time / 1000;
  const gx = w * (0.5 + 0.22 * Math.sin(sec * 0.07));
  const glow = ctx.createRadialGradient(gx, -hgt * 0.05, 0, gx, -hgt * 0.05, hgt * 0.75);
  glow.addColorStop(0, rgba(c, 0.26 * k));
  glow.addColorStop(1, rgba(c, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, hgt);
  // 格子（ゆっくり上へ流れる）
  if (lattice) {
    const oy = (sec * 2) % 33;
    ctx.globalAlpha = Math.min(1, k);
    ctx.drawImage(lattice, 0, -oy);
    ctx.drawImage(lattice, 0, hgt - oy);
    ctx.globalAlpha = 1;
  }
  ctx.globalCompositeOperation = 'lighter';
  // 光の帯（斜め。3 本がずれた速さで横切る）
  for (let i = 0; i < 3; i++) {
    const speed = 0.012 + i * 0.006;
    const p = ((sec * speed + i * 0.37) % 1.6) - 0.3;
    const cx = p * (w + hgt);
    const bw = w * (0.18 + i * 0.07);
    ctx.save();
    ctx.translate(cx - hgt * 0.4, hgt * 0.5);
    ctx.rotate(-0.5);
    const gr = ctx.createLinearGradient(-bw, 0, bw, 0);
    gr.addColorStop(0, rgba(c, 0));
    gr.addColorStop(0.5, rgba(c, (0.05 + 0.02 * i) * k));
    gr.addColorStop(1, rgba(c, 0));
    ctx.fillStyle = gr;
    ctx.fillRect(-bw, -hgt, bw * 2, hgt * 2);
    ctx.restore();
  }
  // 粒子（下から上へ。またたく）
  for (const p of particles) {
    const y = ((p.y - sec * p.sp * p.z) % 1 + 1) % 1;
    const x = ((p.x + Math.sin(sec * 0.3 + p.ph) * 0.02 + sec * p.drift) % 1 + 1) % 1;
    const tw = 0.5 + 0.5 * Math.sin(sec * (1.2 + p.z) + p.ph);
    const a = (0.12 + 0.35 * tw) * p.z * Math.min(1, y * 3) * k;
    const r = p.size * p.z;
    ctx.fillStyle = rgba(c, a * 0.5);
    ctx.beginPath();
    ctx.arc(x * w, y * hgt, r * 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(255, 250, 235, ${a})`;
    ctx.beginPath();
    ctx.arc(x * w, y * hgt, r * 0.8, 0, Math.PI * 2);
    ctx.fill();
  }
  // ゆっくり降りる走査の光
  const sy = ((sec * 0.06) % 1.3 - 0.15) * hgt;
  const scan = ctx.createLinearGradient(0, sy - 40, 0, sy + 40);
  scan.addColorStop(0, 'rgba(255, 255, 255, 0)');
  scan.addColorStop(0.5, rgba(c, 0.05 * k));
  scan.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = scan;
  ctx.fillRect(0, sy - 40, w, 80);
  ctx.globalCompositeOperation = 'source-over';
}

function running() {
  return !!canvas && visible && !covered && !document.hidden && !reducedMotion();
}

function loop(now) {
  raf = 0;
  if (!running()) return;
  raf = requestAnimationFrame(loop);
  if (now - last < FRAME_MS - 1) return;
  last = now;
  t = now;
  // 色はゆっくり寄せる
  let moved = false;
  for (let i = 0; i < 3; i++) {
    const d = target[i] - color[i];
    if (Math.abs(d) > 0.5) { color[i] += d * 0.08; moved = true; } else color[i] = target[i];
  }
  if (moved && now - latticeAt > 200) { latticeAt = now; makeLattice(); }
  draw(now);
}

/** 動かす / 止めるを今の状態に合わせる */
function refresh() {
  if (!canvas) return;
  if (running()) {
    if (!raf) raf = requestAnimationFrame(loop);
  } else {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (!covered) {
      // 止めるときも 1 枚は描いておく（動きを減らす設定で背景が真っ黒にならないように）
      color = target.slice();
      makeLattice();
      draw(t || 0);
    }
  }
}

/**
 * 端末に背景を付ける（何度呼んでもよい。2 回目からは何もしない）
 * @param {HTMLElement} phoneEl .phone
 */
export function attach(phoneEl) {
  if (typeof document === 'undefined' || !phoneEl) return;
  if (canvas && canvas.parentNode === phoneEl) return;
  host = phoneEl;
  canvas = document.createElement('canvas');
  canvas.className = 'ambient';
  canvas.setAttribute('aria-hidden', 'true');
  phoneEl.insertBefore(canvas, phoneEl.firstChild);
  ctx = canvas.getContext('2d', { alpha: false });
  makeParticles();
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resize).observe(phoneEl);
  if (typeof IntersectionObserver !== 'undefined') {
    new IntersectionObserver((es) => {
      visible = es.some((e) => e.isIntersecting);
      refresh();
    }).observe(phoneEl);
  }
  document.addEventListener('visibilitychange', refresh);
  onMotionChange(refresh);
  try {
    window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', refresh);
  } catch { /* 古いブラウザ */ }
  resize();
  refresh();
}

/**
 * 今の場面を伝える。
 * @param {{color?:string, app?:string, intensity?:number}} scene color はランドの色（#rrggbb）。app が地図なら止める
 */
export function setScene(scene = {}) {
  const c = parseColor(scene.color);
  if (c) target = c;
  if (scene.intensity != null) intensity = scene.intensity;
  if (scene.app != null) covered = COVERED_APPS.has(scene.app);
  if (canvas) canvas.hidden = covered;
  refresh();
}

/** 一瞬だけ明るくする（ランドを選んだ・ターンが明けた など） */
export function pulse(color) {
  const c = parseColor(color);
  if (c) target = c;
  pulseUntil = (typeof performance !== 'undefined' ? performance.now() : 0) + 900;
  refresh();
}

/** テスト・確認用: 動いているか */
export function isRunning() {
  return !!raf;
}
