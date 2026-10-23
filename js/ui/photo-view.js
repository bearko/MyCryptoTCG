// photo-view.js — MCH Photo（SPEC-111 §7）
//
// ・持っているエクステンション（land.extensions）を写真のグリッドで。タップで詳細 → 装備する（部隊を選ぶ）/ 捨てる（確認つき）
// ・装備中のものは部隊の名前つきで別の段に
// ・スワイプ選択（pending.kind === "extension"）: 8 枚が重なって出る。右へはらう = アリ、左 = ナシ。
//   指でもマウスでも矢印キーでも。56px 未満で放せば戻る。途中まで動かすとその側が光る。
//   上に 10 秒のタイマー（setTimeout は UI 側。残り時間は演出だけで報酬を変えない）。
//   時間切れか 8 枚終わったら souls.acceptExtension(liked) → 手に入ったものを大きく出す
// 装備の付け替えは souls.equip、獲得は souls.acceptExtension に任せる（ここでは選ぶだけ）。

import { h, clear, heroImg, imgEl, toast, reducedMotion } from './h.js';
import { uiText } from '../engine/lines.js';
import { acceptExtension, equip } from '../engine/souls.js';
import { save } from '../state.js';
import { render as renderApp, openPopup, closePopup, confirmPopup } from '../main.js';

/** スワイプを確定する距離（px） */
export const SWIPE_THRESHOLD = 56;
/** スワイプ選択の持ち時間（ms） */
export const SWIPE_MS = 10000;
/** カードが飛んでいく演出（ms） */
const FLY_MS = 220;

const t = (app, key) => uiText(app.db, key);
const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? m : String(vars[k])));

function heroOf(db, id) {
  return db.heroes[id] || db.heroes[String(id)] || null;
}

function myLand(app) {
  return app.state.lands[app.state.playerLand];
}

function mySquads(app) {
  const st = app.state;
  return Object.values(st.squads || {}).filter((s) => s.land === st.playerLand);
}

function extPending(app) {
  const st = app.state;
  return (st.pending || []).find((p) => p.kind === 'extension' && p.land === st.playerLand) || null;
}

function extImg(ext, cls, size) {
  return imgEl(ext.image, ext.name, { class: cls, width: size, height: size, draggable: 'false' });
}

// ------------------------------------------------------------
// 詳細（ポップアップ）
// ------------------------------------------------------------

function afterChange(app, msg) {
  save(app.state);
  closePopup();
  renderApp();
  if (msg) toast(msg, { key: 'photo' });
}

/** 持っているものの詳細: 装備する（部隊を選ぶ）/ 捨てる */
function openOwned(app, extId) {
  const db = app.db;
  const ext = db.extensions[extId];
  if (!ext) return;
  const squads = mySquads(app);
  const body = h('div', { class: 'ext-detail' },
    h('div', { class: 'ext-detail__head' },
      extImg(ext, 'ext-detail__img', 96),
      h('div', null, h('p', { class: 'ext-detail__name' }, ext.name), h('p', { class: 'ext-detail__text' }, ext.text))),
    h('h3', { class: 'section-title' }, t(app, 'photo.pickSquad')),
    squads.length
      ? h('ul', { class: 'equip-pick' }, squads.map((sq) => {
        const hero = heroOf(db, sq.heroId);
        const cur = sq.equip ? db.extensions[sq.equip] : null;
        return h('li', null, h('button', {
          class: 'equip-pick__btn', type: 'button', dataset: { squad: sq.id },
          onClick: () => {
            if (equip(app.state, db, sq.id, extId)) afterChange(app, fill(t(app, 'photo.equippedMsg'), { name: hero ? hero.name : sq.id, ext: ext.name }));
          },
        },
        hero ? heroImg(hero, { class: 'equip-pick__img', width: 40, height: 40 }) : null,
        h('span', { class: 'equip-pick__name' }, hero ? hero.name : sq.id),
        h('span', { class: 'equip-pick__cur muted' }, cur ? fill(t(app, 'photo.swap'), { ext: cur.name }) : t(app, 'drive.noEquip'))));
      }))
      : h('p', { class: 'empty muted' }, t(app, 'chat.noSquads')),
    h('div', { class: 'btn-row' },
      h('button', {
        class: 'btn-danger', type: 'button',
        onClick: () => confirmPopup(t(app, 'photo.discardConfirm'), () => {
          const land = myLand(app);
          const i = (land.extensions || []).indexOf(extId);
          if (i >= 0) land.extensions.splice(i, 1);
          afterChange(app, fill(t(app, 'photo.discarded'), { ext: ext.name }));
        }, { danger: true, okText: t(app, 'photo.discard'), title: ext.name }),
      }, t(app, 'photo.discard')),
      h('button', { class: 'btn-secondary', type: 'button', onClick: () => closePopup() }, t(app, 'common.close'))));
  openPopup(body, { title: t(app, 'photo.title') });
}

/** 装備中のものの詳細: 外す */
function openEquipped(app, squad) {
  const db = app.db;
  const ext = db.extensions[squad.equip];
  const hero = heroOf(db, squad.heroId);
  if (!ext) return;
  const body = h('div', { class: 'ext-detail' },
    h('div', { class: 'ext-detail__head' },
      extImg(ext, 'ext-detail__img', 96),
      h('div', null,
        h('p', { class: 'ext-detail__name' }, ext.name),
        h('p', { class: 'ext-detail__text' }, ext.text),
        h('p', { class: 'muted' }, fill(t(app, 'photo.equippedBy'), { name: hero ? hero.name : squad.id })))),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn-secondary', type: 'button', onClick: () => closePopup() }, t(app, 'common.close')),
      h('button', {
        class: 'btn-primary', type: 'button',
        onClick: () => { if (equip(app.state, db, squad.id, null)) afterChange(app, fill(t(app, 'photo.unequipped'), { ext: ext.name })); },
      }, t(app, 'photo.unequip'))));
  openPopup(body, { title: t(app, 'photo.equipped') });
}

// ------------------------------------------------------------
// 一覧
// ------------------------------------------------------------

function gallery(app) {
  const db = app.db;
  const land = myLand(app);
  const equipped = mySquads(app).filter((s) => s.equip && db.extensions[s.equip]);
  const owned = (land.extensions || []).filter((id) => db.extensions[id]);
  return [
    h('section', { class: 'photo-sec', 'aria-labelledby': 'photo-eq-title' },
      h('h2', { class: 'section-title', id: 'photo-eq-title' }, `${t(app, 'photo.equipped')}（${equipped.length}）`),
      equipped.length
        ? h('ul', { class: 'photo-equipped' }, equipped.map((sq) => {
          const ext = db.extensions[sq.equip];
          const hero = heroOf(db, sq.heroId);
          return h('li', null, h('button', { class: 'photo-equipped__btn', type: 'button', onClick: () => openEquipped(app, sq) },
            extImg(ext, 'photo-equipped__img', 48),
            h('span', { class: 'photo-equipped__text' },
              h('span', { class: 'photo-equipped__name' }, ext.name),
              h('span', { class: 'photo-equipped__hero muted' }, hero ? hero.name : sq.id))));
        }))
        : h('p', { class: 'empty muted' }, t(app, 'photo.noEquipped'))),
    h('section', { class: 'photo-sec', 'aria-labelledby': 'photo-own-title' },
      h('h2', { class: 'section-title', id: 'photo-own-title' }, `${t(app, 'photo.owned')}（${owned.length}）`),
      owned.length
        ? h('ul', { class: 'photo-grid' }, owned.map((id) => {
          const ext = db.extensions[id];
          return h('li', null, h('button', {
            class: 'photo-tile', type: 'button', 'aria-label': `${ext.name} ${ext.text}`, dataset: { ext: id },
            onClick: () => openOwned(app, id),
          }, extImg(ext, 'photo-tile__img', 96), h('span', { class: 'photo-tile__name' }, ext.name)));
        }))
        : h('p', { class: 'empty muted' }, t(app, 'photo.empty'))),
  ];
}

// ------------------------------------------------------------
// 手に入れたもの（大きく）
// ------------------------------------------------------------

function gotView(app, extId) {
  const ext = app.db.extensions[extId];
  if (!ext) return null;
  const done = () => { app.ui.photoGot = null; renderApp(); };
  return h('section', { class: 'photo-got', role: 'status', 'aria-live': 'polite' },
    h('p', { class: 'photo-got__label' }, t(app, 'photo.got')),
    h('div', { class: 'photo-got__card' }, extImg(ext, 'photo-got__img', 192)),
    h('p', { class: 'photo-got__name' }, ext.name),
    h('p', { class: 'photo-got__text' }, ext.text),
    h('div', { class: 'btn-row photo-got__actions' },
      h('button', { class: 'btn-secondary', type: 'button', onClick: done }, t(app, 'common.close')),
      h('button', {
        class: 'btn-primary', type: 'button',
        onClick: () => { app.ui.photoGot = null; renderApp(); if ((myLand(app).extensions || []).includes(extId)) openOwned(app, extId); },
      }, t(app, 'photo.equip'))));
}

// ------------------------------------------------------------
// スワイプ選択
// ------------------------------------------------------------

// 実行中のスワイプの DOM と後片付け（mount で作り unmount で消す）
let live = null;

/** app.ui.swipe を今の pending に合わせて用意する（進み具合は描き直しても残す） */
function swipeState(app, p) {
  let s = app.ui.swipe;
  if (!s || s.fort !== p.fort || s.done) {
    s = { fort: p.fort, i: 0, liked: [], deadline: null, done: false };
    app.ui.swipe = s;
  }
  return s;
}

function swipeCard(app, ext, n, total, top) {
  return h('div', {
    class: ['swipe-card', top ? 'is-top' : null], dataset: { ext: ext.id },
    style: { '--depth': String(n) },
    role: top ? 'group' : null, 'aria-roledescription': top ? t(app, 'photo.cardRole') : null,
    'aria-label': top ? `${ext.name} ${ext.text}` : null, 'aria-hidden': top ? null : 'true',
  },
  h('span', { class: 'swipe-card__stamp swipe-card__stamp--yes', 'aria-hidden': 'true' }, t(app, 'photo.swipeYes')),
  h('span', { class: 'swipe-card__stamp swipe-card__stamp--no', 'aria-hidden': 'true' }, t(app, 'photo.swipeNo')),
  extImg(ext, 'swipe-card__img', 160),
  h('span', { class: 'swipe-card__name' }, ext.name),
  h('span', { class: 'swipe-card__text' }, ext.text),
  h('span', { class: 'swipe-card__count muted num' }, `${total - n} / ${total}`));
}

function swipeView(app, p) {
  const s = swipeState(app, p);
  const cands = (p.candidates || []).filter((id) => app.db.extensions[id]);
  return h('section', { class: 'swipe', 'aria-labelledby': 'swipe-title' },
    h('header', { class: 'swipe__head' },
      h('h2', { class: 'swipe__title', id: 'swipe-title' }, t(app, 'photo.swipeTitle')),
      h('p', { class: 'swipe__hint muted' }, t(app, 'photo.swipeHint'))),
    h('div', { class: 'swipe__timer', role: 'timer', 'aria-label': t(app, 'photo.timer') },
      h('span', { class: 'swipe__timer-track', 'aria-hidden': 'true' }, h('span', { class: 'swipe__timer-fill' })),
      h('span', { class: 'swipe__timer-text num' }, '10')),
    h('div', { class: 'swipe__stage' },
      h('span', { class: 'swipe__side swipe__side--no', 'aria-hidden': 'true' }, t(app, 'photo.swipeNo')),
      h('div', { class: 'swipe__stack', dataset: { left: String(cands.length - s.i) } }),
      h('span', { class: 'swipe__side swipe__side--yes', 'aria-hidden': 'true' }, t(app, 'photo.swipeYes'))),
    h('div', { class: 'swipe__buttons' },
      h('button', { class: 'btn-danger swipe__btn swipe__btn--no', type: 'button', dataset: { dir: 'left' } },
        h('span', { 'aria-hidden': 'true' }, '← '), t(app, 'photo.swipeNo')),
      h('button', { class: 'btn-primary swipe__btn swipe__btn--yes', type: 'button', dataset: { dir: 'right' } },
        t(app, 'photo.swipeYes'), h('span', { 'aria-hidden': 'true' }, ' →'))),
    h('p', { class: 'swipe__liked muted num', 'aria-live': 'polite' }, ''));
}

function mountSwipe(app, el, p) {
  const s = swipeState(app, p);
  const cands = (p.candidates || []).filter((id) => app.db.extensions[id]);
  const stack = el.querySelector('.swipe__stack');
  const fillEl = el.querySelector('.swipe__timer-fill');
  const textEl = el.querySelector('.swipe__timer-text');
  const likedEl = el.querySelector('.swipe__liked');
  const reduce = reducedMotion();
  const L = { app, p, s, cands, el, stack, timers: [], offs: [], drag: null, busy: false };
  live = L;

  if (s.deadline == null) s.deadline = performance.now() + SWIPE_MS;

  const drawStack = () => {
    clear(stack);
    const rest = cands.slice(s.i);
    stack.dataset.left = String(rest.length);
    // 奥から手前へ（最後に足したものがいちばん上）。重ねるのは最大 8 枚
    for (let n = rest.length - 1; n >= 0; n--) {
      const ext = app.db.extensions[rest[n]];
      stack.appendChild(swipeCard(app, ext, n, cands.length, n === 0));
    }
    likedEl.textContent = fill(t(app, 'photo.likedCount'), { n: s.liked.length });
  };

  const finish = () => {
    if (s.done || live !== L) return;
    s.done = true;
    let got = null;
    try {
      got = acceptExtension(app.state, app.db, app.state.playerLand, p, s.liked.slice());
    } catch (e) {
      console.error(e);
    }
    save(app.state);
    app.ui.swipe = null;
    app.ui.photoGot = got;
    renderApp();
  };

  const decide = (dir) => {
    if (L.busy || s.done || s.i >= cands.length) return;
    const top = stack.querySelector('.swipe-card.is-top');
    const id = cands[s.i];
    if (dir === 'right') s.liked.push(id);
    s.i += 1;
    const next = () => {
      L.busy = false;
      if (live !== L) return;
      if (s.i >= cands.length) finish();
      else drawStack();
    };
    if (top && !reduce) {
      L.busy = true;
      top.classList.add('is-flying', dir === 'right' ? 'is-yes' : 'is-no');
      top.style.transform = `translateX(${dir === 'right' ? 140 : -140}%) rotate(${dir === 'right' ? 18 : -18}deg)`;
      L.timers.push(setTimeout(next, FLY_MS));
    } else {
      next();
    }
  };

  // 指・マウス（Pointer Events）。はらう向きがそのまま答え。56px 未満で放せば戻る
  const setLean = (card, dx) => {
    const k = Math.min(1, Math.abs(dx) / SWIPE_THRESHOLD);
    card.style.transform = `translateX(${dx}px) rotate(${dx / 18}deg)`;
    card.style.setProperty('--lean', String(k));
    card.classList.toggle('lean-yes', dx > 8);
    card.classList.toggle('lean-no', dx < -8);
    el.classList.toggle('lean-yes', dx > 8);
    el.classList.toggle('lean-no', dx < -8);
    el.style.setProperty('--lean', String(k));
  };
  const resetLean = (card) => {
    card.classList.add('is-returning');
    setLean(card, 0);
    card.classList.remove('lean-yes', 'lean-no');
    el.classList.remove('lean-yes', 'lean-no');
    L.timers.push(setTimeout(() => card.classList.remove('is-returning'), 180));
  };
  const onDown = (e) => {
    const card = e.target.closest('.swipe-card.is-top');
    if (!card || L.busy || s.done) return;
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    L.drag = { id: e.pointerId, x0: e.clientX, dx: 0, card };
    try { card.setPointerCapture(e.pointerId); } catch { /* 取れなくても動く */ }
    card.classList.add('is-dragging');
  };
  const onMove = (e) => {
    const d = L.drag;
    if (!d || d.id !== e.pointerId) return;
    d.dx = e.clientX - d.x0;
    setLean(d.card, d.dx);
  };
  const onUp = (e) => {
    const d = L.drag;
    if (!d || d.id !== e.pointerId) return;
    L.drag = null;
    d.card.classList.remove('is-dragging');
    if (e.type === 'pointerup' && Math.abs(d.dx) >= SWIPE_THRESHOLD) {
      el.classList.remove('lean-yes', 'lean-no');
      decide(d.dx > 0 ? 'right' : 'left');
    } else {
      resetLean(d.card);
    }
  };
  const onKey = (e) => {
    if (app.ui.popup || live !== L) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); decide('right'); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); decide('left'); }
  };
  const onBtn = (e) => {
    const b = e.target.closest('.swipe__btn');
    if (b) decide(b.dataset.dir);
  };

  const add = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    L.offs.push(() => target.removeEventListener(type, fn, opts));
  };
  add(stack, 'pointerdown', onDown);
  add(stack, 'pointermove', onMove);
  add(stack, 'pointerup', onUp);
  add(stack, 'pointercancel', onUp);
  add(stack, 'lostpointercapture', onUp);
  add(el, 'click', onBtn);
  add(document, 'keydown', onKey);

  // タイマー（演出だけ。残り時間は報酬を変えない）
  const tick = () => {
    if (live !== L || s.done) return;
    const left = Math.max(0, s.deadline - performance.now());
    fillEl.style.width = `${(left / SWIPE_MS) * 100}%`;
    textEl.textContent = String(Math.ceil(left / 1000));
    el.classList.toggle('is-hurry', left <= 3000);
    if (left <= 0) {
      finish();
      return;
    }
    L.timers.push(setTimeout(tick, 100));
  };
  drawStack();
  tick();
}

function unmountSwipe() {
  if (!live) return;
  for (const off of live.offs) off();
  for (const id of live.timers) clearTimeout(id);
  live = null;
}

// ------------------------------------------------------------

export function render(app) {
  const p = extPending(app);
  let body;
  // 手に入れたものを先に見せる（続けてもう 1 回あるときは、閉じると次のスワイプ）
  if (app.ui.photoGot) body = gotView(app, app.ui.photoGot);
  else if (p) body = swipeView(app, p);
  else body = gallery(app);
  return h('section', { class: ['app-screen', 'app-screen--photo', 'photo', p && !app.ui.photoGot ? 'is-swiping' : null] },
    h('header', { class: 'app-head' },
      h('h1', { class: 'app-title' }, t(app, 'app.photo')),
      h('span', { class: 'app-head__sub muted' }, t(app, 'photo.title'))),
    body);
}

export function mount(app, el) {
  const p = extPending(app);
  if (!p || app.ui.photoGot) return;
  const sw = el.querySelector('.swipe');
  if (sw) mountSwipe(app, sw, p);
}

export function unmount(app) {
  unmountSwipe();
  // ほかのアプリへ移るときは「手に入れた」の表示を閉じる（スワイプの進み具合と持ち時間は残す）
  if (app && app.ui.app !== 'photo') app.ui.photoGot = null;
}
