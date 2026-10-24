// land-select-view.js — ランド選択（最初の画面。SPEC-111 §1・SPEC-112 §6）
//
// 9 ランドのカード（ランドの色・ランドセクタのアイコン・クリプタイド）。カードは順に浮かび上がる。
// 1 枚タップで、そのカードが画面いっぱいに広がりランドの色で染まる → newGame → save → ホーム。

import { h, imgEl, landAssetPath } from './h.js';
import { uiText } from '../engine/lines.js';
import { startGame } from '../main.js';
import { navi } from './phone.js';
import * as fx from './fx.js';
import * as ambient from './ambient.js';

let starting = false;

function newSeed() {
  // UI 側なので Date.now を使ってよい（engine には渡すだけ）
  return (Date.now() ^ Math.floor(performance.now() * 1000)) >>> 0;
}

function fill(text, vars) {
  return text.replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? m : String(vars[k])));
}

/** 選んだカードが画面いっぱいに広がる幕（端末の中。画面の切り替えより手前） */
function burst(app, land, card) {
  const phone = card.closest('.phone');
  if (!phone || fx.reducedMotion() || !card.animate) return null;
  const name = land.nameJa || land.name;
  const el = h('div', { class: 'land-burst', style: { '--land': land.color }, 'aria-hidden': 'true' },
    imgEl(landAssetPath(land.cryptid), '', { class: 'land-burst__art pixel' }),
    h('div', { class: 'land-burst__name' }, name),
    h('div', { class: 'land-burst__sub' }, fill(uiText(app.db, 'land.go'), { name: land.name })));
  phone.appendChild(el);
  const box = phone.getBoundingClientRect();
  const r = card.getBoundingClientRect();
  const inset = `inset(${r.top - box.top}px ${box.right - r.right}px ${box.bottom - r.bottom}px ${r.left - box.left}px round 12px)`;
  el.animate([
    { clipPath: inset, filter: 'brightness(1.6)' },
    { clipPath: 'inset(0px 0px 0px 0px round 0px)', filter: 'brightness(1)' },
  ], { duration: 520, easing: 'cubic-bezier(.7, 0, .2, 1)', fill: 'both' });
  const art = el.querySelector('.land-burst__art');
  if (art) art.animate([{ transform: 'scale(.4) translateY(30px)', opacity: 0 }, { offset: 0.6, opacity: 1 }, { transform: 'scale(1.06)', offset: 0.85 }, { transform: 'none', opacity: 1 }],
    { duration: 760, delay: 160, easing: 'cubic-bezier(.16, 1, .3, 1)', fill: 'both' });
  for (const [i, sel] of ['.land-burst__name', '.land-burst__sub'].entries()) {
    const n = el.querySelector(sel);
    if (n) n.animate([{ transform: 'translateY(14px)', opacity: 0, letterSpacing: '.5em' }, { transform: 'none', opacity: 1 }],
      { duration: 520, delay: 360 + i * 90, easing: 'cubic-bezier(.16, 1, .3, 1)', fill: 'both' });
  }
  return el;
}

function pickLand(app, land, card) {
  if (starting) return;
  starting = true;
  card.classList.add('is-picked');
  const root = card.closest('.land-select');
  if (root) {
    root.setAttribute('aria-busy', 'true');
    for (const c of root.querySelectorAll('.land-card')) if (c !== card) c.classList.add('is-dim');
  }
  ambient.pulse(land.color);
  const curtain = burst(app, land, card);
  const run = () => {
    try {
      startGame(land.id, newSeed());
    } catch (e) {
      console.error(e);
      card.classList.remove('is-picked');
      if (root) root.removeAttribute('aria-busy');
      if (curtain) curtain.remove();
      starting = false;
      return;
    }
    starting = false;
    ambient.pulse(land.color);
    if (!curtain) return;
    // 染まった幕が晴れて、ホームが現れる
    const a = curtain.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(1.08)', filter: 'blur(6px)' }],
      { duration: 460, easing: 'cubic-bezier(.4, 0, .2, 1)', fill: 'forwards' });
    a.finished.then(() => curtain.remove(), () => curtain.remove());
  };
  // 押したことが見えるように描画を挟む。幕があるときは、広がりきって名前が出るまで待つ
  setTimeout(run, curtain ? 980 : 30);
}

export function render(app) {
  const lands = app.db.lands || [];
  const nv = navi(app, { face: 'wave', text: uiText(app.db, 'navi.land.lead'), ctx: 'land' });
  nv.bubble.classList.add('land-select__lead');
  const root = h('section', { class: 'land-select' },
    h('header', { class: 'land-select__head' },
      h('div', { class: 'land-select__navi-clip' }, nv.figure),
      h('h1', { class: 'land-select__title' }, uiText(app.db, 'land.title')),
      h('div', { class: 'land-select__guide' }, nv.bubble)));
  const grid = h('div', { class: 'land-grid' });
  lands.forEach((land, i) => {
    const name = land.nameJa || land.name;
    const card = h('button', {
      class: 'land-card', type: 'button', style: { '--land': land.color, '--i': i }, dataset: { land: land.id },
      'aria-label': `${name}（${land.name}）${uiText(app.db, 'land.start')}`,
    },
    h('span', { class: 'land-card__art' },
      imgEl(landAssetPath(land.cryptid), `${name}のクリプタイド`, { class: 'land-card__cryptid' }),
      imgEl(landAssetPath(land.icon), `${name}のランドセクタ`, { class: 'land-card__icon' })),
    h('span', { class: 'land-card__name' }, name),
    h('span', { class: 'land-card__en' }, land.name));
    card.addEventListener('click', () => pickLand(app, land, card));
    // 触れたランドの色で、奥の光がそっと染まる（A）
    const preview = () => { if (!starting) ambient.setScene({ color: land.color }); };
    card.addEventListener('pointerenter', preview);
    card.addEventListener('focus', preview);
    grid.appendChild(card);
  });
  root.appendChild(grid);
  root._navi = nv;
  return root;
}

/** カードが浮かび上がる間隔と長さ（9 枚で約 800ms。最初の 1 秒以内に全部押せる） */
const CARD_STEP = 60;
const CARD_MS = 320;

export function mount(app, el) {
  if (!el) return;
  // 吹き出しは最初から言い終えたときの大きさで置き、その中に 1 文字ずつ出す
  // （伸びながら出ると、出始めが「率いるランドを…」で切れたように見えるため）
  const bubble = el._navi && el._navi.bubble;
  if (bubble && bubble.isConnected) {
    // 出てくる動き（scale）の途中でも測れるよう、変形の影響を受けない offset の寸法で
    const w = bubble.offsetWidth;
    if (w > 0) {
      bubble.style.width = `${w + 1}px`;
      bubble.style.minHeight = `${bubble.offsetHeight}px`;
    }
  }
  if (el._navi) el._navi.start();
  // 9 枚が順に浮かび上がる
  fx.stagger(el.querySelectorAll('.land-card'), { step: CARD_STEP, delay: 40, ms: CARD_MS, from: 'up', distance: 18 });
}

export function unmount() {
  // 画面を離れたら、プレビューの色は main.js が次の描画で自ランドの色に戻す
}
