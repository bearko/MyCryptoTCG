// fx.js — 手触りの部品（SPEC-112 §1。使い方は SPEC-112 の「付録: fx の API」）
//
// 押したら波紋 / 数値が転がる / トースト / 帯 / カットイン / 1 文字ずつ / アイコンの位置から開く・閉じる /
// 順に出す / MCH の 100px グリッドのスプライトを 1 回再生 / 動きを減らす。
// ゲームのルールはここに書かない（見た目と手触りだけ）。DOM が無い環境（node --test）では何もしない。
// h.js に依存しない（h.js がここを読むので、循環させない）。

import { img } from '../constants.js';
import { getSetting, setSetting, playSe } from './audio.js';

const HAS_DOM = typeof document !== 'undefined' && typeof window !== 'undefined';

// ------------------------------------------------------------
// 小道具
// ------------------------------------------------------------

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = String(text);
  return e;
}

/** トースト・帯・カットインを置く場所（端末の中。無ければ body） */
function layer() {
  return document.querySelector('#app > .phone') || document.body;
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** CSS の時間トークン（ms）。読めなければ def */
export function token(name, def) {
  if (!HAS_DOM) return def;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!v) return def;
  const n = parseFloat(v);
  return v.endsWith('ms') ? n : v.endsWith('s') ? n * 1000 : def;
}

// ------------------------------------------------------------
// 動きを減らす（prefers-reduced-motion か、設定の「動きを減らす」）
// ------------------------------------------------------------

const motionListeners = new Set();

/** 動きを減らすか（OS の設定か、ゲームの設定） */
export function reducedMotion() {
  if (getSetting('reduceMotion', false) === true) return true;
  try {
    return !!(HAS_DOM && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch {
    return false;
  }
}

/** ゲームの設定「動きを減らす」 */
export function getReduceMotionSetting() {
  return getSetting('reduceMotion', false) === true;
}

/** ゲームの設定「動きを減らす」を変える（<html data-motion> も変える。onMotionChange の関数を呼ぶ） */
export function setReduceMotion(on) {
  setSetting('reduceMotion', !!on);
  applyMotionAttr();
  for (const fn of motionListeners) {
    try { fn(reducedMotion()); } catch (e) { console.error(e); }
  }
}

/** 動きを減らすかが変わったら呼ばれる関数を足す。外す関数を返す */
export function onMotionChange(fn) {
  motionListeners.add(fn);
  return () => motionListeners.delete(fn);
}

function applyMotionAttr() {
  if (!HAS_DOM) return;
  if (getReduceMotionSetting()) document.documentElement.dataset.motion = 'reduce';
  else delete document.documentElement.dataset.motion;
}

// ------------------------------------------------------------
// 波紋（押した場所から）
// ------------------------------------------------------------

/**
 * 要素の上に、押した場所から広がる波紋を出す。要素の形（角丸）に切り抜く。
 * 要素の中には何も足さない（レイアウトを崩さない。fixed の箱を上に重ねる）。
 * @param {Element} target
 * @param {number} [x] clientX（省略時は中心）
 * @param {number} [y] clientY
 * @param {{accent?:boolean}} [opts]
 */
export function ripple(target, x, y, opts = {}) {
  if (!HAS_DOM || !target || !target.getBoundingClientRect || reducedMotion()) return null;
  const r = target.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  const cs = getComputedStyle(target);
  const box = el('span', `fx-ripple${opts.accent ? ' fx-ripple--accent' : ''}`);
  box.setAttribute('aria-hidden', 'true');
  box.style.left = `${r.left}px`;
  box.style.top = `${r.top}px`;
  box.style.width = `${r.width}px`;
  box.style.height = `${r.height}px`;
  box.style.borderRadius = cs.borderRadius;
  const px = (x ?? r.left + r.width / 2) - r.left;
  const py = (y ?? r.top + r.height / 2) - r.top;
  const d = Math.hypot(Math.max(px, r.width - px), Math.max(py, r.height - py)) * 2 * 1.45;
  const dot = el('span', 'fx-ripple__dot');
  dot.style.left = `${px}px`;
  dot.style.top = `${py}px`;
  dot.style.width = dot.style.height = `${d}px`;
  box.appendChild(dot);
  document.body.appendChild(box);
  // 押したものが消えたら（画面が切り替わったら）波紋も一緒に消す。新しい画面の上に残さない
  const t0 = performance.now();
  const watch = () => {
    if (!box.isConnected) return;
    if (!target.isConnected || target.closest('.phone__ghost') || performance.now() - t0 > 560) { box.remove(); return; }
    requestAnimationFrame(watch);
  };
  requestAnimationFrame(watch);
  return box;
}

const PRESSABLE = 'button, [role="button"], [data-ripple], .panel--press, a[href]';
let installed = false;

/**
 * 全体の手触りを入れる（起動時に 1 度）。
 * - 押せるもの（button など）を押したら波紋 + タップの SE（音が ON のときだけ）
 * - 設定の「動きを減らす」を <html data-motion> に反映
 * data-ripple="off" の要素（とその中）では波紋を出さない。
 */
export function install() {
  if (!HAS_DOM || installed) return;
  installed = true;
  applyMotionAttr();
  document.addEventListener('pointerdown', (e) => {
    if (e.button && e.button !== 0) return;
    const t = e.target instanceof Element ? e.target.closest(PRESSABLE) : null;
    if (!t || t.disabled || t.closest('[data-ripple="off"]')) return;
    ripple(t, e.clientX, e.clientY, { accent: t.classList.contains('btn-primary') || t.dataset.ripple === 'accent' });
    playSe(t.classList.contains('btn-primary') ? 'confirm' : 'tap');
  }, { passive: true, capture: true });
}

// ------------------------------------------------------------
// 数値が転がる
// ------------------------------------------------------------

const rollMemory = new Map();

/**
 * 数値をカウントアップ / ダウンさせて表示する。増えたら緑、減ったら赤で一瞬光る。
 * 描き直しで要素が作り直されても、key を渡せば前回の値から転がる。
 * @param {Element} target 文字を差し替える要素
 * @param {number} to
 * @param {{from?:number, key?:string, ms?:number, format?:(n:number)=>string, flash?:boolean}} [opts]
 */
export function rollNumber(target, to, opts = {}) {
  const format = opts.format || ((n) => String(Math.round(n)));
  if (!target) return;
  let from = opts.from;
  if (from == null && opts.key != null && rollMemory.has(opts.key)) from = rollMemory.get(opts.key);
  if (from == null && target._rollValue != null) from = target._rollValue;
  if (opts.key != null) rollMemory.set(opts.key, to);
  target._rollValue = to;
  if (!HAS_DOM || from == null || from === to || !Number.isFinite(from) || !Number.isFinite(to)) {
    target.textContent = format(to);
    return;
  }
  target.classList.add('fx-roll');
  if (opts.flash !== false) {
    target.classList.remove('is-up', 'is-down');
    void target.offsetWidth; // アニメーションを最初から
    target.classList.add(to > from ? 'is-up' : 'is-down');
  }
  if (reducedMotion()) {
    target.textContent = format(to);
    return;
  }
  const ms = opts.ms ?? Math.min(900, 380 + Math.abs(to - from) * 6);
  const t0 = performance.now();
  if (target._rollRaf) cancelAnimationFrame(target._rollRaf);
  const tick = (now) => {
    const k = Math.min(1, (now - t0) / ms);
    const e = 1 - Math.pow(1 - k, 3);
    target.textContent = format(from + (to - from) * e);
    if (k < 1) target._rollRaf = requestAnimationFrame(tick);
    else target._rollRaf = null;
  };
  target.textContent = format(from);
  target._rollRaf = requestAnimationFrame(tick);
}

// ------------------------------------------------------------
// トースト（右上）
// ------------------------------------------------------------

let toastStack = null;

/** 実行フェーズの最中か（main.js が .phone に is-executing を付ける） */
function isExecuting() {
  const p = document.querySelector('#app > .phone');
  return !!(p && p.classList.contains('is-executing'));
}

function stack() {
  const host = layer();
  if (toastStack && toastStack.parentNode === host) return toastStack;
  if (toastStack) toastStack.remove();
  toastStack = el('div', 'toast-stack');
  toastStack.setAttribute('role', 'status');
  toastStack.setAttribute('aria-live', 'polite');
  host.appendChild(toastStack);
  return toastStack;
}

function dismissToast(t) {
  clearTimeout(t._timer);
  if (reducedMotion()) { t.remove(); return; }
  t.classList.add('is-leaving');
  setTimeout(() => t.remove(), 230);
}

/**
 * トーストを出す。
 * @param {string} text
 * @param {{key?:string, ms?:number, kind?:'good'|'bad'|'warn'|'info', icon?:string}} [opts]
 *   key が直前のトーストと同じなら、そのトーストの文を差し替えて弾ませる。icon は MCH の相対パス（"Image/Icons/gum.png"）
 */
export function toast(text, opts = {}) {
  if (!HAS_DOM) return null;
  const s = stack();
  const ms = Math.min(opts.ms ?? 2200, isExecuting() ? 2400 : Infinity);
  const last = s.lastElementChild;
  if (opts.key && last && last.dataset.key === opts.key && !last.classList.contains('is-leaving')) {
    last.querySelector('.toast__text').textContent = text;
    clearTimeout(last._timer);
    last.classList.remove('is-bump');
    void last.offsetWidth;
    last.classList.add('is-bump');
    const bar = last.querySelector('.toast__timer');
    if (bar) { bar.style.animation = 'none'; void bar.offsetWidth; bar.style.animation = ''; }
    last._timer = setTimeout(() => dismissToast(last), ms);
    return last;
  }
  const t = el('div', `toast${opts.kind ? ` toast--${opts.kind}` : ''}`);
  t.dataset.key = opts.key || '';
  t.style.setProperty('--toast-ms', `${ms}ms`);
  if (opts.icon) {
    const i = el('img', 'toast__icon');
    i.src = img(opts.icon);
    i.alt = '';
    i.addEventListener('error', () => i.remove(), { once: true });
    t.appendChild(i);
  }
  t.appendChild(el('span', 'toast__text', text));
  t.appendChild(el('span', 'toast__timer'));
  s.appendChild(t);
  // 実行フェーズは演出が続くので 2 枚まで（古いものから押し出す）。ふだんは 4 枚まで
  const max = isExecuting() ? 2 : 4;
  while (s.children.length > max) s.firstElementChild.remove();
  t._timer = setTimeout(() => dismissToast(t), ms);
  return t;
}

// ------------------------------------------------------------
// 帯（画面中央）
// ------------------------------------------------------------

/**
 * 画面中央の帯（砦の陥落・週の終わりなど）。ms 後に消える。
 * @param {string} text
 * @param {number|{ms?:number, kind?:'good'|'bad'|'info', sub?:string, slim?:boolean}} [opts] 数なら ms（以前の書き方）。slim は高さ 44px の細い帯
 */
export function band(text, opts = {}) {
  if (!HAS_DOM) return null;
  if (typeof opts === 'number') opts = { ms: opts };
  const ms = opts.ms ?? 1400;
  bandCalls += 1;
  const b = el('div', `band${opts.kind ? ` band--${opts.kind}` : ''}${opts.slim ? ' band--slim' : ''}`);
  b.setAttribute('role', 'status');
  b.setAttribute('aria-live', 'assertive');
  b.style.setProperty('--band-ms', `${ms}ms`);
  b.appendChild(el('span', 'band__text', text));
  if (opts.sub) b.appendChild(el('span', 'band__sub', opts.sub));
  // 帯は 1 本ずつ（重なると両方読めない）。前の帯は新しいものに席を譲る
  for (const old of layer().querySelectorAll(':scope > .band')) old.remove();
  layer().appendChild(b);
  setTimeout(() => b.remove(), ms);
  return b;
}

// ------------------------------------------------------------
// カットイン
// ------------------------------------------------------------

// 全画面のカットインは「自ランドが落とした / 落とされた」ときだけ。敵どうしの陥落は細い帯に格下げする。
// どちらかはイベントを見ている main.js が知っているので、陥落のイベントを 1 つ渡すたびに
// pushCutinScope(major) で積む。そのイベントの演出が帯で済んだ（同期で band を呼んだ）なら
// settleCutinScope で取り消す。cutin は呼ばれた順に 1 つずつ取り出す（ビューが順に並べて呼ぶため）。
let bandCalls = 0;
const cutinScopes = [];
let scopeMark = null;

/** 陥落のイベントを 1 つビューへ渡す直前に呼ぶ。major = プレイヤーのランドが関わるか */
export function pushCutinScope(major) {
  cutinScopes.push(!!major);
  scopeMark = bandCalls;
}

/** ビューへ渡し終えたら呼ぶ。その間に帯を出したならカットインは来ないので、積んだものを取り消す */
export function settleCutinScope() {
  if (scopeMark != null && bandCalls > scopeMark) cutinScopes.pop();
  scopeMark = null;
}

/** 出ているカットインを今すぐ終える（画面を移ったとき。次の画面の上に帯が残って押す邪魔をしないように） */
export function dismissCutins() {
  if (!HAS_DOM) return;
  for (const c of document.querySelectorAll('.fx-cutin')) {
    if (typeof c._finish === 'function') c._finish();
    else c.remove();
  }
}

/** 実行フェーズが終わったら（スキップも含む）積み残しを捨てる */
export function clearCutinScopes() {
  cutinScopes.length = 0;
  scopeMark = null;
}

/**
 * カットイン（斜めの帯に、左右から絵が滑り込む。絵の下側は文字の手前にも重なる）。タップで早送り。
 * 全面を覆うが押すのは邪魔しない（受け口は斜めの帯だけ）。「スキップ」はいつもこれより手前にある。
 * @param {{image?:string, title:string, sub?:string, side?:'ally'|'opponent'|'accent', ms?:number, pixel?:boolean, se?:string, major?:boolean}} opts
 *   image は MCH の相対パス（"Image/Heroes/1001.png"）。major:false なら細い帯に格下げ（side:'opponent' は
 *   main.js が積んだ印でプレイヤーに関わると分かったときだけ全画面）
 * @returns {Promise<void>} 終わったら解決
 */
export function cutin(opts = {}) {
  if (!HAS_DOM) return Promise.resolve();
  const scope = cutinScopes.length ? cutinScopes.shift() : undefined;
  const major = opts.major ?? (opts.side === 'opponent' ? scope === true : true);
  if (!major) {
    band(opts.sub || opts.title || '', { kind: 'bad', ms: 900, slim: true });
    return Promise.resolve();
  }
  const reduce = reducedMotion();
  const ms = opts.ms ?? (reduce ? 900 : 1600);
  const side = opts.side || 'ally';
  const root = el('div', `fx-cutin fx-cutin--${side}${reduce ? ' is-static' : ''}`);
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'assertive');
  root.style.setProperty('--cut-ms', `${ms}ms`);
  // 題の大きさ: 空白で区切った一番長いかたまりが 1 行に収まる大きさ（語の途中で折り返さない）
  const longest = Math.max(2, ...String(opts.title || '').split(/\s+/).map((w) => Array.from(w).length));
  root.style.setProperty('--fit', String(longest));
  const bandEl = el('div', 'fx-cutin__band');
  bandEl.appendChild(el('div', 'fx-cutin__shine'));
  bandEl.appendChild(el('div', 'fx-cutin__lines'));
  root.appendChild(bandEl);
  const art = (cls) => {
    const a = el('div', `fx-cutin__art ${cls}`);
    const i = el('img');
    i.src = img(opts.image);
    i.alt = '';
    i.addEventListener('error', () => a.remove(), { once: true });
    if (opts.pixel === false) i.style.imageRendering = 'auto';
    a.appendChild(i);
    return a;
  };
  if (opts.image) root.appendChild(art('fx-cutin__art--back'));
  const text = el('div', 'fx-cutin__text');
  text.appendChild(el('p', 'fx-cutin__title', opts.title || ''));
  if (opts.sub) text.appendChild(el('p', 'fx-cutin__sub', opts.sub));
  root.appendChild(text);
  if (opts.image) {
    const front = art('fx-cutin__art--front');
    front.setAttribute('aria-hidden', 'true');
    root.appendChild(front);
  }
  layer().appendChild(root);
  if (opts.se !== null) playSe(opts.se || 'fall');
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      root.remove();
      resolve();
    };
    const timer = setTimeout(finish, ms);
    root._finish = () => { clearTimeout(timer); finish(); };
    bandEl.addEventListener('pointerdown', () => { clearTimeout(timer); finish(); }, { once: true });
  });
}

// ------------------------------------------------------------
// 1 文字ずつ（吹き出し）
// ------------------------------------------------------------

/**
 * 文字を 1 文字ずつ出す。タップ（target か opts.skipOn）で全文。読み上げには最初から全文を渡す。
 * 吹き出しが inline-block / fit-content なら、文字数に合わせて伸びていく。
 * @param {Element} target
 * @param {string} text
 * @param {{cps?:number, delay?:number, skipOn?:Element, caret?:boolean, onDone?:Function}} [opts] cps は 1 秒あたりの文字数（既定 40）
 * @returns {{skip:Function, cancel:Function, done:Promise<void>}}
 */
export function typeText(target, text, opts = {}) {
  text = String(text ?? '');
  const chars = Array.from(text);
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  const ctl = { skip: () => {}, cancel: () => {}, done };
  if (!target) { resolveDone(); return ctl; }
  if (!HAS_DOM || reducedMotion() || chars.length <= 1) {
    target.textContent = text;
    resolveDone();
    if (opts.onDone) opts.onDone();
    return ctl;
  }
  target.textContent = '';
  const sr = el('span', 'sr-only', text);
  const vis = el('span');
  vis.setAttribute('aria-hidden', 'true');
  const caret = opts.caret === false ? null : el('span', 'fx-type__caret');
  if (caret) caret.setAttribute('aria-hidden', 'true');
  target.append(sr, vis);
  if (caret) target.appendChild(caret);
  const step = 1000 / (opts.cps || 40);
  let i = 0;
  let timer = null;
  let finished = false;
  const skipOn = opts.skipOn || target;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    skipOn.removeEventListener('pointerdown', onTap);
    target.textContent = text;
    resolveDone();
    if (opts.onDone) opts.onDone();
  };
  const onTap = () => finish();
  const tick = () => {
    if (finished) return;
    if (!target.isConnected) { finished = true; resolveDone(); return; }
    i += 1;
    vis.textContent = chars.slice(0, i).join('');
    if (i >= chars.length) { finish(); return; }
    // 句読点で少しためる
    const c = chars[i - 1];
    timer = setTimeout(tick, /[、。！？!?…]/.test(c) ? step * 5 : step);
  };
  skipOn.addEventListener('pointerdown', onTap);
  timer = setTimeout(tick, opts.delay ?? 0);
  ctl.skip = finish;
  ctl.cancel = () => { finished = true; clearTimeout(timer); skipOn.removeEventListener('pointerdown', onTap); resolveDone(); };
  return ctl;
}

// ------------------------------------------------------------
// アイコンの位置から開く・閉じる（clip-path で切り抜きを広げる / 縮める）
// ------------------------------------------------------------

function insetFrom(rect, box, radius) {
  const top = Math.max(0, rect.top - box.top);
  const left = Math.max(0, rect.left - box.left);
  const right = Math.max(0, box.right - rect.right);
  const bottom = Math.max(0, box.bottom - rect.bottom);
  return `inset(${top}px ${right}px ${bottom}px ${left}px round ${radius}px)`;
}

/** 開く・閉じるときに、アイコンの枠が画面いっぱいへ広がって見える光の枠（押せない・寸法に効かない） */
function zoomFrame(fromRect, toRect, ms, reverse) {
  const f = el('div', 'fx-zoomframe');
  f.setAttribute('aria-hidden', 'true');
  f.style.left = `${toRect.left}px`;
  f.style.top = `${toRect.top}px`;
  f.style.width = `${toRect.width}px`;
  f.style.height = `${toRect.height}px`;
  document.body.appendChild(f);
  const sx = fromRect.width / toRect.width;
  const sy = fromRect.height / toRect.height;
  const tx = fromRect.left - toRect.left;
  const ty = fromRect.top - toRect.top;
  const small = { transform: `translate(${tx}px, ${ty}px) scale(${sx}, ${sy})`, opacity: 1 };
  const big = { transform: 'none', opacity: 0 };
  const a = f.animate(reverse ? [{ ...big, opacity: 0.9 }, small] : [small, { opacity: 0.8, offset: 0.6 }, big],
    { duration: ms, easing: 'cubic-bezier(.2, .8, .2, 1)', fill: 'forwards' });
  a.finished.then(() => f.remove(), () => f.remove());
}

/**
 * target を、fromRect（アイコンの位置。getBoundingClientRect の値）から広がるように見せる。
 * target の大きさ・位置は変えない（clip-path と明るさだけ）ので、開いている最中も当たり判定と寸法は本物のまま。
 * 手前を光の枠がアイコンから画面いっぱいへ広がる。
 * @param {Element} target
 * @param {DOMRect|{left,top,right,bottom,width,height}} fromRect
 * @param {{ms?:number, radius?:number}} [opts]
 * @returns {Promise<void>}
 */
export function flipOpen(target, fromRect, opts = {}) {
  if (!HAS_DOM || !target || !target.animate || !fromRect || reducedMotion()) return Promise.resolve();
  const ms = opts.ms ?? token('--t-flip', 380);
  const box = target.getBoundingClientRect();
  const from = insetFrom(fromRect, box, opts.radius ?? 16);
  const to = `inset(0px 0px 0px 0px round ${opts.endRadius ?? 0}px)`;
  zoomFrame(fromRect, box, ms, false);
  const a = target.animate([
    { clipPath: from, filter: 'brightness(1.7) saturate(1.2)', opacity: 0.3 },
    { offset: 0.5, filter: 'brightness(1.1)', opacity: 1 },
    { clipPath: to, filter: 'none', opacity: 1 },
  ], { duration: ms, easing: 'cubic-bezier(.25, .8, .25, 1)' });
  return a.finished.then(() => {}, () => {});
}

/**
 * target（消える画面の写し。押せないもの）を toRect（アイコンの位置）へ縮めて消す。終わったら target を外す。
 * 写しなので、ここでは大きさも変える（アイコンの大きさまで縮む）。
 * @param {Element} target
 * @param {DOMRect|{left,top,right,bottom,width,height}} toRect
 * @param {{ms?:number, radius?:number, remove?:boolean}} [opts]
 * @returns {Promise<void>}
 */
export function flipClose(target, toRect, opts = {}) {
  const removeIt = () => { if (opts.remove !== false && target) target.remove(); };
  if (!HAS_DOM || !target || !target.animate || !toRect || reducedMotion()) { removeIt(); return Promise.resolve(); }
  const ms = opts.ms ?? token('--t-flip', 380);
  const box = target.getBoundingClientRect();
  const s = Math.max(0.05, toRect.width / box.width);
  const sy = Math.max(0.05, toRect.height / box.height);
  // 縦横で縮み方を変えると中身がつぶれるので、幅に合わせて縮め、高さは切り抜きで合わせる
  const cx = toRect.left + toRect.width / 2 - (box.left + box.width / 2);
  const cy = toRect.top + toRect.height / 2 - (box.top + box.height / 2);
  const cut = Math.max(0, (box.height - box.width * (sy / s)) / 2);
  const r = (opts.radius ?? 16) / s;
  const a = target.animate([
    { transform: 'none', clipPath: `inset(0px 0px 0px 0px round ${opts.startRadius ?? 0}px)`, opacity: 1, filter: 'none' },
    { offset: 0.75, opacity: 0.95, filter: 'brightness(1.15)' },
    { transform: `translate(${cx}px, ${cy}px) scale(${s})`, clipPath: `inset(${cut}px 0px ${cut}px 0px round ${r}px)`, opacity: 0, filter: 'brightness(1.6)' },
  ], { duration: ms, easing: 'cubic-bezier(.4, 0, .2, 1)', fill: 'forwards' });
  return a.finished.then(removeIt, removeIt);
}

/**
 * 横にすべらせて入れ替える（アプリ内のタブ・画面の切り替え）。target は新しい中身。
 * @param {Element} target
 * @param {1|-1} [dir] 1: 右から入る / -1: 左から入る
 * @param {{ms?:number, distance?:number}} [opts]
 */
export function slideIn(target, dir = 1, opts = {}) {
  if (!HAS_DOM || !target || !target.animate || reducedMotion()) return Promise.resolve();
  const d = (opts.distance ?? 28) * dir;
  const a = target.animate([
    { transform: `translateX(${d}px)`, opacity: 0 },
    { transform: 'none', opacity: 1 },
  ], { duration: opts.ms ?? token('--t-ui', 240), easing: 'cubic-bezier(.16, 1, .3, 1)' });
  return a.finished.then(() => {}, () => {});
}

// ------------------------------------------------------------
// 順に出す
// ------------------------------------------------------------

/**
 * 要素を順に出す（下から浮かび上がる）。描き直しのたびに呼んでよい。
 * @param {Iterable<Element>|NodeList} nodes
 * @param {{step?:number, delay?:number, ms?:number, from?:'up'|'down'|'left'|'right'|'scale'|'flip', distance?:number}} [opts]
 * @returns {Promise<void>} 全部出たら解決
 */
export function stagger(nodes, opts = {}) {
  const list = Array.from(nodes || []).filter(Boolean);
  if (!HAS_DOM || !list.length || reducedMotion() || !list[0].animate) return Promise.resolve();
  const step = opts.step ?? 45;
  const ms = opts.ms ?? 420;
  const dist = opts.distance ?? 14;
  const start = {
    up: `translateY(${dist}px)`,
    down: `translateY(${-dist}px)`,
    left: `translateX(${dist}px)`,
    right: `translateX(${-dist}px)`,
    scale: 'scale(.9)',
    flip: 'perspective(600px) rotateY(90deg)',
  }[opts.from || 'up'];
  const anims = list.map((n, i) => n.animate([
    { transform: start, opacity: 0 },
    { transform: 'none', opacity: 1 },
  ], { duration: ms, delay: (opts.delay ?? 0) + i * step, easing: 'cubic-bezier(.16, 1, .3, 1)', fill: 'backwards' }));
  return Promise.all(anims.map((a) => a.finished.catch(() => {}))).then(() => {});
}

// ------------------------------------------------------------
// MCH のバトルエフェクト（100px グリッドのスプライト）を 1 回再生
// ------------------------------------------------------------

/** Image/Effects/Battle の各スプライトの 1 辺のコマ数と、絵の入っているコマ数 */
export const SPRITES = {
  '01_single_damage': { grid: 9, frames: 75 },
  '02_area_damage': { grid: 8, frames: 61 },
  '03_heal_resurrection': { grid: 6, frames: 31 },
  '04_buff': { grid: 9, frames: 73 },
  '05_debuff_status_effect': { grid: 7, frames: 41 },
  '06_effect_06': { grid: 7, frames: 46 },
  '07_effect_07': { grid: 8, frames: 61 },
  '08_effect_08': { grid: 8, frames: 61 },
  '09_effect_09': { grid: 8, frames: 61 },
  '10_effect_10': { grid: 8, frames: 61 },
  '11_effect_11': { grid: 8, frames: 61 },
  '12_effect_12': { grid: 8, frames: 62 },
};

/**
 * スプライトを 1 回再生する。
 * @param {string} name SPRITES のキー（"01_single_damage"）か、MCH の相対パス
 * @param {Element|{x:number,y:number}} at 要素ならその中心、{x,y} なら clientX / clientY
 * @param {{size?:number, fps?:number, grid?:number, frames?:number, blend?:string}} [opts] size は表示の 1 辺（px。既定 160。1 コマ 100px の絵を拡大する）
 * @returns {Promise<void>}
 */
export function spriteOnce(name, at, opts = {}) {
  if (!HAS_DOM || reducedMotion()) return Promise.resolve();
  const meta = SPRITES[name] || {};
  const path = SPRITES[name] ? `Image/Effects/Battle/${name}.png` : name;
  const grid = opts.grid ?? meta.grid ?? 8;
  const frames = opts.frames ?? meta.frames ?? grid * grid;
  const size = opts.size ?? 160;
  const fps = opts.fps ?? 50;
  let cx; let cy;
  if (at && typeof at.getBoundingClientRect === 'function') {
    const r = at.getBoundingClientRect();
    cx = r.left + r.width / 2;
    cy = r.top + r.height / 2;
  } else {
    cx = (at && at.x) || 0;
    cy = (at && at.y) || 0;
  }
  const s = el('div', 'fx-sprite');
  s.setAttribute('aria-hidden', 'true');
  s.style.left = `${cx - size / 2}px`;
  s.style.top = `${cy - size / 2}px`;
  s.style.width = s.style.height = `${size}px`;
  s.style.backgroundImage = `url("${img(path)}")`;
  s.style.backgroundSize = `${grid * size}px ${grid * size}px`;
  if (opts.blend) s.style.mixBlendMode = opts.blend;
  const pos = (i) => { s.style.backgroundPosition = `${-(i % grid) * size}px ${-Math.floor(i / grid) * size}px`; };
  pos(0);
  document.body.appendChild(s);
  return new Promise((resolve) => {
    const t0 = performance.now();
    const tick = (now) => {
      const i = Math.floor(((now - t0) / 1000) * fps);
      if (i >= frames || !s.isConnected) { s.remove(); resolve(); return; }
      pos(i);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

// ------------------------------------------------------------
// まとめ
// ------------------------------------------------------------

export const fx = {
  install, reducedMotion, setReduceMotion, getReduceMotionSetting, onMotionChange, token,
  ripple, rollNumber, toast, band, cutin, pushCutinScope, settleCutinScope, clearCutinScopes, dismissCutins, typeText, flipOpen, flipClose, slideIn, stagger, spriteOnce, wait, SPRITES,
};
export { wait };
export default fx;
