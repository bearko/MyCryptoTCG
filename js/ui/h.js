// h.js — DOM ヘルパ（SPEC-110 §4・SPEC-111 §10）
//
// h(tag, attrs, ...children) で要素を作る。attrs の on* はイベント（onClick → click）、
// class / style（文字列か object）/ dataset（object）に対応。children は文字列・数・要素・配列・null。
// ゲームのルールはここに書かない（UI の部品だけ）。

import { img } from '../constants.js';

/**
 * 要素を作る。
 * @param {string} tag
 * @param {object|null} [attrs]
 * @param {...any} children
 * @returns {HTMLElement}
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class' || k === 'className') {
        el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : String(v);
      } else if (k === 'style') {
        if (typeof v === 'string') el.style.cssText = v;
        else for (const [sk, sv] of Object.entries(v)) {
          if (sv == null) continue;
          if (sk.startsWith('--')) el.style.setProperty(sk, String(sv));
          else el.style[sk] = sv;
        }
      } else if (k === 'dataset') {
        for (const [dk, dv] of Object.entries(v)) if (dv != null) el.dataset[dk] = String(dv);
      } else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (k === 'html') {
        // 使わない（XSS を避ける）。誤って渡されたら文字として入れる
        el.textContent = String(v);
      } else if (v === true) {
        el.setAttribute(k, '');
      } else if (k in el && (k === 'value' || k === 'checked' || k === 'disabled' || k === 'hidden')) {
        el[k] = v;
      } else {
        el.setAttribute(k, String(v));
      }
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false || c === true) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

/** 子要素を全部消す */
export function clear(el) {
  if (!el) return el;
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/** addEventListener の短縮。外すための関数を返す */
export function on(el, type, fn, opts) {
  el.addEventListener(type, fn, opts);
  return () => el.removeEventListener(type, fn, opts);
}

/** 動きを減らす設定か */
export function reducedMotion() {
  try {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------
// 画像（MCH リポジトリの相対パス → URL。alt 必須・失敗時は代替）
// ------------------------------------------------------------

/**
 * lands.json の icon / cryptid は "Image/LandSectors/..." "Image/Cryptids/..."（SPEC-110 §1.3）。
 * 古い書き方 "assets/lands/..." "assets/cryptids/..." が来ても MCH リポジトリのパスに読み替える。
 * すでに "Image/..." ならそのまま。
 */
export function landAssetPath(p) {
  if (!p) return p;
  if (p.startsWith('assets/lands/')) return 'Image/LandSectors/' + p.slice('assets/lands/'.length);
  if (p.startsWith('assets/cryptids/')) return 'Image/Cryptids/' + p.slice('assets/cryptids/'.length);
  return p;
}

/**
 * MCH の画像。読み込みに失敗したら、代替の文字（alt の頭文字）を出す箱に差し替える。
 * @param {string} relPath "Image/Heroes/1001.png"
 * @param {string} alt
 * @param {object} [attrs] class など
 */
export function imgEl(relPath, alt, attrs = {}) {
  const el = h('img', { ...attrs, src: relPath ? img(relPath) : '', alt: alt || '', loading: 'lazy', decoding: 'async' });
  el.addEventListener('error', () => {
    const fb = h('span', { class: ['img-fallback', attrs.class], role: 'img', 'aria-label': alt || '' }, (alt || '?').slice(0, 1));
    if (el.parentNode) el.parentNode.replaceChild(fb, el);
  }, { once: true });
  return el;
}

/** ヒーローの絵（ドット絵なので pixelated） */
export function heroImg(hero, attrs = {}) {
  const cls = ['hero-img', attrs.class].filter(Boolean).join(' ');
  return imgEl(hero ? hero.image : null, hero ? hero.name : '', { ...attrs, class: cls });
}

// ------------------------------------------------------------
// トースト（右上に小さく。連続する同じ key は 1 つにまとめる）
// ------------------------------------------------------------

let toastStack = null;

function stack() {
  if (toastStack && document.body.contains(toastStack)) return toastStack;
  toastStack = h('div', { class: 'toast-stack', role: 'status', 'aria-live': 'polite' });
  document.body.appendChild(toastStack);
  return toastStack;
}

/**
 * トーストを出す。
 * @param {string} text
 * @param {{key?:string, ms?:number, kind?:string}} [opts] key が直前のトーストと同じなら、そのトーストの文を差し替える
 */
export function toast(text, opts = {}) {
  if (typeof document === 'undefined') return null;
  const s = stack();
  const ms = opts.ms ?? 2200;
  const last = s.lastElementChild;
  if (opts.key && last && last.dataset.key === opts.key) {
    last.textContent = text;
    clearTimeout(last._timer);
    last._timer = setTimeout(() => last.remove(), ms);
    return last;
  }
  const el = h('div', { class: ['toast', opts.kind ? `toast--${opts.kind}` : null], dataset: { key: opts.key || '' } }, text);
  s.appendChild(el);
  while (s.children.length > 4) s.firstElementChild.remove();
  el._timer = setTimeout(() => el.remove(), ms);
  return el;
}

/**
 * 画面中央の帯（砦の陥落など）。ms 後に消える。
 * @param {string} text
 * @param {number} [ms]
 */
export function band(text, ms = 1200) {
  if (typeof document === 'undefined') return null;
  const el = h('div', { class: 'band', role: 'status', 'aria-live': 'assertive' }, h('span', { class: 'band__text' }, text));
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
  return el;
}
