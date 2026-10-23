// app-kit.js — Calendar / Drive / Photo で共通の部品（SPEC-112 §5・§7）
//
// ・appHead: 画面の頭（アプリ名・小見出し・「?」）
// ・helpPopup: 用語の「?」。用語と意味の一覧をポップアップで出す（focus の用語を光らせて見せる）
// ・firstGuide: 初めて開いたアプリでだけ、ナビゲーターが 1 回だけ要点を言う（mcw.settings に記録）
// ・entering: 別の画面から入ってきた最初の描画か（描き直しのたびに演出をやり直さないため）
// ゲームのルールはここに書かない（見た目と案内だけ）。

import { h } from './h.js';
import { uiText } from '../engine/lines.js';
import { openPopup, closePopup } from '../main.js';
import { getSetting, setSetting } from './audio.js';
import { navi } from './phone.js';
import * as fx from './fx.js';

const t = (app, key) => uiText(app.db, key);

/** 文言が無いときの代わり（キーがそのまま出ないように） */
export function tx(app, key, fallback) {
  const s = t(app, key);
  return s === key ? fallback : s;
}

// ------------------------------------------------------------
// 入ってきた最初の描画か
// ------------------------------------------------------------

const entered = new Set();

/**
 * その画面に別の画面から入ってきた最初の mount なら true（以後の描き直しでは false）。
 * unmount で leave(name) を呼ぶと、次に入ってきたときにまた true になる。
 */
export function entering(name) {
  if (entered.has(name)) return false;
  entered.add(name);
  return true;
}

export function leave(name) {
  entered.delete(name);
}

// ------------------------------------------------------------
// 画面の頭
// ------------------------------------------------------------

/**
 * @param {object} app
 * @param {{title:string, sub?:any, help?:Function, back?:Function, cls?:string}} o
 *   back を渡すと左に「＜ 戻る」（SPEC-112 §7.5.1。1 つ前へ）、help を渡すと右に「?」
 */
export function appHead(app, o) {
  return h('header', { class: ['app-head', o.back ? 'has-back' : null, o.cls] },
    o.back ? h('button', { class: 'app-head__back', type: 'button', onClick: () => o.back() },
      h('span', { class: 'app-head__chev', 'aria-hidden': 'true' }), tx(app, 'common.back', '戻る')) : null,
    h('div', { class: 'app-head__text' },
      h('h1', { class: 'app-title' }, o.title),
      o.sub != null ? h('span', { class: 'app-head__sub muted' }, o.sub) : null),
    o.help ? h('button', {
      class: 'app-head__help', type: 'button', 'aria-label': `${o.title} ${tx(app, 'help.title', '説明')}`,
      onClick: () => o.help(),
    }, h('span', { 'aria-hidden': 'true' }, '?')) : null);
}

// ------------------------------------------------------------
// 用語の「?」
// ------------------------------------------------------------

/**
 * 用語の説明をポップアップで出す。
 * @param {object} app
 * @param {{title:string, lead?:string, items:{id:string, term:string, text:string, tag?:any}[], focus?:string}} o
 */
export function helpPopup(app, o) {
  const list = h('dl', { class: 'terms' }, o.items.map((it, i) => h('div', {
    class: ['terms__row', it.id === o.focus ? 'is-focus' : null], dataset: { term: it.id }, style: { '--i': String(i) },
  },
  h('dt', { class: 'terms__term' }, it.tag || null, h('span', null, it.term)),
  h('dd', { class: 'terms__text' }, it.text))));
  const body = h('div', { class: 'help' },
    o.lead ? h('p', { class: 'help__lead' }, o.lead) : null,
    list,
    h('div', { class: 'btn-row' }, h('button', { class: 'btn-secondary', type: 'button', onClick: () => closePopup() }, tx(app, 'common.close', '閉じる'))));
  openPopup(body, { title: o.title });
  const rows = list.querySelectorAll('.terms__row');
  fx.stagger(rows, { step: 28, delay: 60, from: 'up', distance: 8, ms: 320 });
  const f = list.querySelector('.is-focus');
  if (f && f.scrollIntoView) f.scrollIntoView({ block: 'nearest' });
}

// ------------------------------------------------------------
// 初回だけの案内
// ------------------------------------------------------------

/** 案内を見たかどうか（mcw.settings のキー） */
const guideKey = (name) => `${name}GuideDone`;

export function guideSeen(name) {
  return getSetting(guideKey(name), false) === true;
}

export function markGuideSeen(name) {
  setSetting(guideKey(name), true);
}

/**
 * 初めて開いたアプリでだけ出す案内（ナビゲーターの立ち絵 + 吹き出し + 「わかった」）。
 * 見たことがあれば null。出した時点では記録せず、「わかった」かアプリを離れたとき（unmount）に記録する。
 * 戻り値の el を差したあと start() を呼ぶと話し始める。
 * @param {object} app
 * @param {{name:string, face?:string, text:string}} o
 * @returns {{el:HTMLElement, start:Function}|null}
 */
export function firstGuide(app, o) {
  if (guideSeen(o.name)) return null;
  const nv = navi(app, { face: o.face || 'point', text: o.text, ctx: `guide:${o.name}`, cls: 'app-guide__navi' });
  const el = h('aside', { class: 'app-guide panel panel--glass', 'aria-label': tx(app, 'navi.name', 'マインちゃん'), dataset: { guide: o.name } },
    h('div', { class: 'app-guide__fig' }, nv.figure),
    h('div', { class: 'app-guide__body' },
      nv.bubble,
      h('button', {
        class: 'btn-ghost app-guide__ok', type: 'button',
        onClick: () => {
          markGuideSeen(o.name);
          closeGuide(el);
        },
      }, tx(app, 'guide.ok', 'わかった'))));
  return { el, start: nv.start };
}

function closeGuide(el) {
  if (!el || !el.isConnected) return;
  if (fx.reducedMotion() || !el.animate) { el.remove(); return; }
  const hgt = el.offsetHeight;
  el.style.overflow = 'hidden';
  el.animate([
    { opacity: 1, height: `${hgt}px`, transform: 'none' },
    { opacity: 0, height: '0px', marginBottom: `calc(-1 * var(--gap))`, paddingTop: '0px', paddingBottom: '0px', transform: 'translateY(-6px) scale(.98)' },
  ], { duration: fx.token('--t-ui', 240) * 1.2, easing: 'cubic-bezier(.55, 0, .75, .2)', fill: 'forwards' })
    .finished.then(() => el.remove(), () => el.remove());
}
