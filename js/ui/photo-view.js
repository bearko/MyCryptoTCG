// photo-view.js — MCH Photo（SPEC-111 §7・SPEC-112 §5）
//
// ・持っているエクステンション（land.extensions）を写真のグリッドで。入ってきたときはシャッターのように順に現れる。
//   タップで詳細 → 装備する（部隊を選ぶ）/ 捨てる（確認つき）
// ・装備中のものは部隊の名前つきで別の段に
// ・スワイプ選択（pending.kind === "extension"）: 8 枚が重なって出る。右へはらう = アリ、左 = ナシ。
//   指でもマウスでも矢印キーでも。カードは指に追従して傾き、影が深くなり、はらう側の光が強くなる。
//   56px 未満で放せば戻る。56px 以上で放すと、その勢い（速さ・向き）のまま飛んでいく。
//   上に 10 秒の円形タイマー（setTimeout / rAF は UI 側。残り時間は演出だけで報酬を変えない）。下に「残り n 秒」。
//   操作中に配置を動かさない: ナビの案内パネルは出さず、見出しの横に小さな顔と 1 行の案内だけ（全文は「?」）。
//   左右の縦タブは置かない。ドラッグ中は、はらう側の下のボタンが光る。アリの数はカードの束の右上のバッジ。
//   時間切れか 8 枚終わったら souls.acceptExtension(liked) → 手に入ったものを大きく出す（フラッシュ）
// 装備の付け替えは souls.equip、獲得は souls.acceptExtension に任せる（ここでは選ぶだけ）。

import { h, clear, heroImg, imgEl, toast, reducedMotion } from './h.js';
import { uiText } from '../engine/lines.js';
import { acceptExtension, equip } from '../engine/souls.js';
import { save } from '../state.js';
import { render as renderApp, openPopup, closePopup, confirmPopup, go } from '../main.js';
import { appHead, helpPopup, entering, leave, tx } from './app-kit.js';
import { naviPath } from './phone.js';
import * as fx from './fx.js';

/** スワイプを確定する距離（px） */
export const SWIPE_THRESHOLD = 56;
/** スワイプ選択の持ち時間（ms） */
export const SWIPE_MS = 10000;
/** カードが飛んでいく演出（ms。ボタン・矢印キーのとき。はらったときは勢いで 160〜300） */
const FLY_MS = 240;

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
// 説明
// ------------------------------------------------------------

export function openHelp(app, focus) {
  const items = ['swipe', 'timer', 'got', 'equip', 'discard'].map((k) => ({ id: k, term: t(app, `help.photo.${k}.term`), text: t(app, `help.photo.${k}`) }));
  // 初回の案内（ナビの吹き出し）は出さないので、その全文をここの頭に置く
  const lead = tx(app, 'photo.guide', '届いたエクステンションは、ほしいなら右（アリ）、いらないなら左（ナシ）へはらってね。アリにした中から 1 つ手に入るよ');
  helpPopup(app, { title: tx(app, 'help.photoTitle', 'Photo の使い方'), lead, items, focus });
}

// ------------------------------------------------------------
// 詳細（ポップアップ）
// ------------------------------------------------------------

function afterChange(app, msg, kind) {
  save(app.state);
  closePopup();
  renderApp();
  if (msg) toast(msg, { key: 'photo', kind: kind || 'good' });
}

function extHero(ext, extraCls) {
  return h('div', { class: ['ext-detail__head', extraCls] },
    h('div', { class: 'ext-detail__photo' }, h('span', { class: 'ext-detail__rays', 'aria-hidden': 'true' }), extImg(ext, 'ext-detail__img', 112)),
    h('div', { class: 'ext-detail__text-wrap' },
      h('p', { class: 'ext-detail__name' }, ext.name),
      h('p', { class: 'ext-detail__text' }, ext.text)));
}

/** 持っているものの詳細: 装備する（部隊を選ぶ）/ 捨てる */
function openOwned(app, extId) {
  const db = app.db;
  const ext = db.extensions[extId];
  if (!ext) return;
  const squads = mySquads(app);
  const body = h('div', { class: 'ext-detail' },
    extHero(ext),
    h('h3', { class: 'section-title' }, t(app, 'photo.pickSquad')),
    squads.length
      ? h('ul', { class: 'equip-pick' }, squads.map((sq, i) => {
        const hero = heroOf(db, sq.heroId);
        const cur = sq.equip ? db.extensions[sq.equip] : null;
        return h('li', { style: { '--i': String(i) } }, h('button', {
          class: 'equip-pick__btn', type: 'button', dataset: { squad: sq.id, rarity: hero ? hero.rarity : null },
          onClick: () => {
            if (equip(app.state, db, sq.id, extId)) afterChange(app, fill(t(app, 'photo.equippedMsg'), { name: hero ? hero.name : sq.id, ext: ext.name }));
          },
        },
        h('span', { class: 'equip-pick__art' }, hero ? heroImg(hero, { class: 'equip-pick__img', width: 48, height: 48 }) : null),
        h('span', { class: 'equip-pick__text' },
          h('span', { class: 'equip-pick__name' }, hero ? hero.name : sq.id),
          h('span', { class: 'equip-pick__cur' }, cur
            ? h('span', { class: 'equip-pick__swap' }, imgEl(cur.image, '', { class: 'equip-pick__cur-img', width: 18, height: 18 }), fill(t(app, 'photo.swap'), { ext: cur.name }))
            : t(app, 'drive.noEquip'))),
        h('span', { class: 'equip-pick__go', 'aria-hidden': 'true' })));
      }))
      : h('p', { class: 'empty muted' }, t(app, 'chat.noSquads')),
    h('div', { class: 'btn-row' },
      h('button', {
        class: 'btn-danger', type: 'button',
        onClick: () => confirmPopup(t(app, 'photo.discardConfirm'), () => {
          const land = myLand(app);
          const i = (land.extensions || []).indexOf(extId);
          if (i >= 0) land.extensions.splice(i, 1);
          afterChange(app, fill(t(app, 'photo.discarded'), { ext: ext.name }), 'info');
        }, { danger: true, okText: t(app, 'photo.discard'), title: ext.name }),
      }, t(app, 'photo.discard')),
      h('button', { class: 'btn-secondary', type: 'button', onClick: () => closePopup() }, t(app, 'common.close'))));
  openPopup(body, { title: t(app, 'photo.title') });
  fx.stagger(body.querySelectorAll('.equip-pick > li'), { step: 50, delay: 120, from: 'left', distance: 14 });
}

/** 装備中のものの詳細: 外す */
function openEquipped(app, squad) {
  const db = app.db;
  const ext = db.extensions[squad.equip];
  const hero = heroOf(db, squad.heroId);
  if (!ext) return;
  const body = h('div', { class: 'ext-detail' },
    extHero(ext),
    h('p', { class: 'ext-detail__by' },
      hero ? heroImg(hero, { class: 'ext-detail__by-img', width: 32, height: 32 }) : null,
      fill(t(app, 'photo.equippedBy'), { name: hero ? hero.name : squad.id })),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn-secondary', type: 'button', onClick: () => closePopup() }, t(app, 'common.close')),
      h('button', {
        class: 'btn-primary', type: 'button',
        onClick: () => { if (equip(app.state, db, squad.id, null)) afterChange(app, fill(t(app, 'photo.unequipped'), { ext: ext.name }), 'info'); },
      }, t(app, 'photo.unequip'))));
  openPopup(body, { title: t(app, 'photo.equipped') });
}

// ------------------------------------------------------------
// 一覧
// ------------------------------------------------------------

function gallery(app) {
  const db = app.db;
  const land = myLand(app);
  const squads = mySquads(app);
  const equipped = squads.filter((s) => s.equip && db.extensions[s.equip]);
  const owned = (land.extensions || []).filter((id) => db.extensions[id]);
  const equipLabel = tx(app, 'photo.equipCta', '装備する');
  // 装備していないときは、何のためのものか（1 行）と、ヒーローを見に行く道を出す
  const bare = squads.filter((s) => !s.equip);
  const emptyEquipped = h('div', { class: 'photo-empty' },
    h('span', { class: 'photo-empty__heroes', 'aria-hidden': 'true' }, bare.slice(0, 4).map((sq, i) => {
      const hero = heroOf(db, sq.heroId);
      return hero ? h('span', { class: 'photo-empty__hero', dataset: { rarity: hero.rarity }, style: { '--k': String(i) } }, heroImg(hero, { class: 'photo-empty__img', width: 48, height: 48, alt: '' })) : null;
    })),
    h('p', { class: 'photo-empty__text' }, tx(app, 'photo.equipWhy', 'ヒーローに持たせると能力が上がる')),
    h('button', { class: 'photo-empty__go', type: 'button', onClick: () => go('drive') },
      h('span', null, tx(app, 'photo.toDrive', 'ヒーローを見る')), h('span', { class: 'photo-empty__chev', 'aria-hidden': 'true' })));
  return [
    h('section', { class: 'photo-sec', 'aria-labelledby': 'photo-eq-title' },
      h('h2', { class: 'section-title', id: 'photo-eq-title' }, t(app, 'photo.equipped'), h('span', { class: 'section-title__n num' }, String(equipped.length))),
      equipped.length
        ? h('ul', { class: 'photo-equipped' }, equipped.map((sq, i) => {
          const ext = db.extensions[sq.equip];
          const hero = heroOf(db, sq.heroId);
          return h('li', { style: { '--d': String(i) } }, h('button', { class: 'photo-equipped__btn', type: 'button', onClick: () => openEquipped(app, sq) },
            h('span', { class: 'photo-equipped__photo' }, extImg(ext, 'photo-equipped__img', 48)),
            h('span', { class: 'photo-equipped__text' },
              h('span', { class: 'photo-equipped__name' }, ext.name),
              h('span', { class: 'photo-equipped__fx' }, ext.text),
              h('span', { class: 'photo-equipped__hero' }, hero ? heroImg(hero, { class: 'photo-equipped__hero-img', width: 20, height: 20 }) : null, hero ? hero.name : sq.id))));
        }))
        : emptyEquipped),
    h('section', { class: 'photo-sec', 'aria-labelledby': 'photo-own-title' },
      h('h2', { class: 'section-title', id: 'photo-own-title' }, t(app, 'photo.owned'), h('span', { class: 'section-title__n num' }, String(owned.length))),
      owned.length
        ? h('ul', { class: ['photo-grid', owned.length <= 4 ? 'photo-grid--big' : null] }, owned.map((id, i) => {
          const ext = db.extensions[id];
          const cols = owned.length <= 4 ? 2 : 3;
          // シャッターは斜めに順に（左上から右下へ）
          const d = Math.floor(i / cols) + (i % cols);
          return h('li', { style: { '--d': String(d) } }, h('button', {
            class: 'photo-tile', type: 'button', 'aria-label': `${ext.name} ${ext.text} ${equipLabel}`, dataset: { ext: id },
            onClick: () => openOwned(app, id),
          },
          h('span', { class: 'photo-tile__pic' }, extImg(ext, 'photo-tile__img', 96)),
          h('span', { class: 'photo-tile__fx' }, ext.text),
          h('span', { class: 'photo-tile__name' }, ext.name),
          // 押すと何が起きるかを書いておく（装備する ＞）
          h('span', { class: 'photo-tile__cta', 'aria-hidden': 'true' }, equipLabel, h('span', { class: 'photo-tile__chev' }))));
        }))
        : h('p', { class: 'empty muted' }, t(app, 'photo.empty'))),
  ];
}

// ------------------------------------------------------------
// 手に入れたもの（大きく）
// ------------------------------------------------------------

/** フラッシュとエフェクトを出した「手に入れた」（描き直しでやり直さない） */
let gotShown = null;

function gotView(app, extId) {
  const ext = app.db.extensions[extId];
  if (!ext) return null;
  const done = () => { app.ui.photoGot = null; renderApp(); };
  return h('section', { class: 'photo-got', role: 'status', 'aria-live': 'polite', dataset: { ext: extId } },
    h('span', { class: 'photo-got__rays', 'aria-hidden': 'true' }),
    h('p', { class: 'photo-got__label' }, t(app, 'photo.got')),
    h('div', { class: 'photo-got__card' },
      h('span', { class: 'photo-got__burst', 'aria-hidden': 'true' }),
      h('span', { class: 'photo-got__burst', 'aria-hidden': 'true' }),
      h('span', { class: 'photo-got__shine', 'aria-hidden': 'true' }),
      extImg(ext, 'photo-got__img', 192)),
    h('p', { class: 'photo-got__name' }, ext.name),
    h('p', { class: 'photo-got__text' }, ext.text),
    h('div', { class: 'btn-row photo-got__actions' },
      h('button', { class: 'btn-secondary', type: 'button', onClick: done }, t(app, 'common.close')),
      h('button', {
        class: 'btn-primary', type: 'button',
        onClick: () => { app.ui.photoGot = null; renderApp(); if ((myLand(app).extensions || []).includes(extId)) openOwned(app, extId); },
      }, t(app, 'photo.equip'))));
}

function playGot(el) {
  const sec = el.querySelector('.photo-got');
  if (!sec) return;
  const id = sec.dataset.ext;
  if (gotShown === id) { sec.classList.add('is-still'); return; }
  gotShown = id;
  if (reducedMotion()) return;
  sec.classList.add('is-fresh');
  // シャッターを切ったような白い光
  const flash = h('div', { class: 'photo-flash', 'aria-hidden': 'true' });
  sec.appendChild(flash);
  setTimeout(() => flash.remove(), 700);
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
    s = { fort: p.fort, i: 0, liked: [], deadline: null, done: false, drag: null, dealt: false };
    app.ui.swipe = s;
  }
  return s;
}

function swipeCard(app, ext, n, total, top) {
  return h('div', {
    class: ['swipe-card', top ? 'is-top' : null], dataset: { ext: ext.id },
    style: { '--depth': String(Math.min(n, 7)) },
    role: top ? 'group' : null, 'aria-roledescription': top ? t(app, 'photo.cardRole') : null,
    'aria-label': top ? `${ext.name} ${ext.text}` : null, 'aria-hidden': top ? null : 'true',
  },
  h('span', { class: 'swipe-card__light', 'aria-hidden': 'true' }),
  h('span', { class: 'swipe-card__stamp swipe-card__stamp--yes', 'aria-hidden': 'true' }, t(app, 'photo.swipeYes')),
  h('span', { class: 'swipe-card__stamp swipe-card__stamp--no', 'aria-hidden': 'true' }, t(app, 'photo.swipeNo')),
  h('span', { class: 'swipe-card__photo' }, extImg(ext, 'swipe-card__img', 160)),
  h('span', { class: 'swipe-card__name' }, ext.name),
  h('span', { class: 'swipe-card__text' }, ext.text),
  h('span', { class: 'swipe-card__count num' }, `${total - n} / ${total}`));
}

function swipeView(app, p) {
  const s = swipeState(app, p);
  const cands = (p.candidates || []).filter((id) => app.db.extensions[id]);
  return h('section', { class: 'swipe', 'aria-labelledby': 'swipe-title' },
    h('header', { class: 'swipe__head' },
      // ナビは小さな顔だけ（吹き出しを伸ばして配置を動かさない）。案内は 1 行に固定
      h('span', { class: 'swipe__navi', 'aria-hidden': 'true' }, imgEl(naviPath('smile'), '', { class: 'swipe__navi-img', draggable: 'false' })),
      h('div', { class: 'swipe__head-text' },
        h('h2', { class: 'swipe__title', id: 'swipe-title' }, t(app, 'photo.swipeTitle')),
        h('p', { class: 'swipe__hint' }, tx(app, 'photo.swipeHintShort', 'ほしいなら右、いらないなら左へはらう'))),
      h('div', { class: 'swipe__timer-wrap' },
        h('div', { class: 'swipe__timer', role: 'timer', 'aria-label': t(app, 'photo.timer'), style: { '--p': '1' } },
          h('span', { class: 'swipe__timer-ring', 'aria-hidden': 'true' }),
          h('span', { class: 'swipe__timer-text num', 'aria-hidden': 'true' }, String(Math.ceil(SWIPE_MS / 1000)))),
        h('span', { class: 'swipe__timer-cap num' }, fill(tx(app, 'photo.timeLeft', '残り {n} 秒'), { n: Math.ceil(SWIPE_MS / 1000) })))),
    h('div', { class: 'swipe__stage' },
      h('span', { class: 'swipe__glow swipe__glow--no', 'aria-hidden': 'true' }),
      h('span', { class: 'swipe__glow swipe__glow--yes', 'aria-hidden': 'true' }),
      h('div', { class: 'swipe__stack', dataset: { left: String(cands.length - s.i) } }),
      // アリにした数（束の右上のバッジ。アリにしたカードの小さな写真が飛び込む）
      h('div', { class: ['swipe__badge', s.liked.length ? 'has-liked' : null] },
        h('span', { class: 'swipe__badge-label' }, t(app, 'photo.swipeYes')),
        h('b', { class: 'swipe__badge-n num swipe__liked', 'aria-live': 'polite' }, String(s.liked.length)),
        h('ul', { class: 'swipe__picks', 'aria-hidden': 'true' }))),
    h('div', { class: 'swipe__buttons' },
      h('button', { class: 'btn-danger swipe__btn swipe__btn--no', type: 'button', dataset: { dir: 'left' } },
        h('span', { class: 'swipe__btn-arrow', 'aria-hidden': 'true' }), t(app, 'photo.swipeNo')),
      h('button', { class: 'btn-primary swipe__btn swipe__btn--yes', type: 'button', dataset: { dir: 'right' } },
        t(app, 'photo.swipeYes'), h('span', { class: 'swipe__btn-arrow', 'aria-hidden': 'true' }))));
}

function mountSwipe(app, el, p) {
  const s = swipeState(app, p);
  const cands = (p.candidates || []).filter((id) => app.db.extensions[id]);
  const stack = el.querySelector('.swipe__stack');
  const timerEl = el.querySelector('.swipe__timer');
  const textEl = el.querySelector('.swipe__timer-text');
  const likedEl = el.querySelector('.swipe__liked');
  const badgeEl = el.querySelector('.swipe__badge');
  const capEl = el.querySelector('.swipe__timer-cap');
  const picksEl = el.querySelector('.swipe__picks');
  const reduce = reducedMotion();
  const L = { app, p, s, cands, el, stack, timers: [], offs: [], drag: null, busy: false, raf: 0 };
  live = L;

  if (s.deadline == null) s.deadline = performance.now() + SWIPE_MS;

  const drawPicks = (fresh) => {
    clear(picksEl);
    // 小さな写真は最後の 3 枚だけ重ねる
    const from = Math.max(0, s.liked.length - 3);
    s.liked.forEach((id, i) => {
      if (i < from) return;
      const ext = app.db.extensions[id];
      if (!ext) return;
      const li = h('li', { class: ['swipe__pick', fresh && i === s.liked.length - 1 ? 'is-new' : null] }, extImg(ext, 'swipe__pick-img', 28));
      picksEl.appendChild(li);
    });
  };

  const drawStack = (rise) => {
    clear(stack);
    const rest = cands.slice(s.i);
    stack.dataset.left = String(rest.length);
    // 奥から手前へ（最後に足したものがいちばん上）。重ねるのは最大 8 枚
    for (let n = rest.length - 1; n >= 0; n--) {
      const ext = app.db.extensions[rest[n]];
      stack.appendChild(swipeCard(app, ext, n, cands.length, n === 0));
    }
    likedEl.textContent = String(s.liked.length);
    badgeEl.setAttribute('aria-label', fill(t(app, 'photo.likedCount'), { n: s.liked.length }));
    badgeEl.classList.toggle('has-liked', s.liked.length > 0);
    // 次のカードが 1 段せり上がる
    const top = stack.querySelector('.swipe-card.is-top');
    if (rise && top && top.animate && !reduce) {
      top.animate([{ transform: 'translateY(8px) scale(.96)', filter: 'brightness(.85)' }, { transform: 'none', filter: 'none' }],
        { duration: 260, easing: 'cubic-bezier(.34, 1.4, .64, 1)' });
    }
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

  /** はらった側の光を一瞬強くする */
  const flashSide = (dir) => {
    if (reduce) return;
    const g = el.querySelector(dir === 'right' ? '.swipe__glow--yes' : '.swipe__glow--no');
    if (g && g.animate) g.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 420, easing: 'ease-out' });
  };

  /**
   * 1 枚決める。m は指の動き（はらったときだけ）: {dx, dy, vx, vy}（px と px/ms）
   */
  const decide = (dir, m) => {
    if (L.busy || s.done || s.i >= cands.length) return;
    const top = stack.querySelector('.swipe-card.is-top');
    const id = cands[s.i];
    const yes = dir === 'right';
    if (yes) s.liked.push(id);
    s.i += 1;
    flashSide(dir);
    if (yes) {
      drawPicks(true);
      likedEl.textContent = String(s.liked.length);
      badgeEl.classList.add('has-liked');
      // バッジが弾む（押したら必ず返る）
      if (badgeEl.animate && !reduce) badgeEl.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.25)', offset: 0.35 }, { transform: 'scale(1)' }], { duration: 360, easing: 'cubic-bezier(.34, 1.56, .64, 1)' });
    }
    const next = () => {
      L.busy = false;
      if (live !== L) return;
      if (s.i >= cands.length) finish();
      else drawStack(true);
    };
    if (top && !reduce) {
      L.busy = true;
      const sign = yes ? 1 : -1;
      const dx = m ? m.dx : 0;
      const dy = m ? m.dy : 0;
      const vx = m ? Math.abs(m.vx) : 0;
      const vy = m ? m.vy : 0;
      // 勢いが強いほど速く・遠くへ。縦の勢いもそのまま乗せる
      const ms = m ? Math.round(Math.max(160, Math.min(300, 300 - vx * 90))) : FLY_MS;
      const tx = sign * (Math.max(420, (stack.clientWidth || 300) * 1.4) + Math.abs(dx));
      const ty = dy * 0.3 + Math.max(-160, Math.min(160, vy * 160));
      const rot = sign * (22 + Math.min(18, vx * 10));
      top.classList.remove('is-dragging', 'is-returning');
      top.classList.add('is-flying', yes ? 'is-yes' : 'is-no');
      top.style.setProperty('--fly-ms', `${ms}ms`);
      top.style.transform = `translate(${tx}px, ${ty}px) rotate(${rot}deg)`;
      L.timers.push(setTimeout(next, ms));
    } else {
      next();
    }
  };

  // 指・マウス（Pointer Events）。はらう向きがそのまま答え。56px 未満で放せば戻る
  const setLean = (card, dx, dy = 0) => {
    const k = Math.min(1, Math.abs(dx) / SWIPE_THRESHOLD);
    card.style.transform = `translate(${dx}px, ${dy * 0.3}px) rotate(${dx / 16}deg)`;
    card.style.setProperty('--lean', String(k));
    card.style.setProperty('--lift', String(Math.min(1, Math.hypot(dx, dy) / 120)));
    card.classList.toggle('lean-yes', dx > 8);
    card.classList.toggle('lean-no', dx < -8);
    el.classList.toggle('lean-yes', dx > 8);
    el.classList.toggle('lean-no', dx < -8);
    el.classList.toggle('is-armed', Math.abs(dx) >= SWIPE_THRESHOLD);
    el.style.setProperty('--lean', String(k));
  };
  const resetLean = (card) => {
    card.classList.add('is-returning');
    setLean(card, 0, 0);
    card.classList.remove('lean-yes', 'lean-no');
    el.classList.remove('lean-yes', 'lean-no', 'is-armed');
    L.timers.push(setTimeout(() => card.classList.remove('is-returning'), 320));
  };
  const onDown = (e) => {
    const card = e.target.closest('.swipe-card.is-top');
    if (!card || L.busy || s.done) return;
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    L.drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, dx: 0, dy: 0, card, hist: [{ x: e.clientX, y: e.clientY, t: e.timeStamp || performance.now() }] };
    try { card.setPointerCapture(e.pointerId); } catch { /* 取れなくても動く */ }
    card.classList.remove('is-returning');
    card.classList.add('is-dragging');
  };
  // render() で DOM が差し替わっても、指が触れたままなら新しいいちばん上のカードで続ける
  // （move / up は document で受けるので、古いカードが消えても届く）
  const resumeDrag = () => {
    const c = s.drag;
    s.drag = null;
    if (!c) return;
    const card = stack.querySelector('.swipe-card.is-top');
    if (!card) return;
    L.drag = { id: c.id, x0: c.x0, y0: c.y0 ?? 0, dx: c.dx, dy: c.dy || 0, card, hist: [] };
    card.classList.add('is-dragging');
    setLean(card, c.dx, c.dy || 0);
  };
  const onMove = (e) => {
    const d = L.drag;
    if (!d || d.id !== e.pointerId) return;
    d.dx = e.clientX - d.x0;
    d.dy = e.clientY - d.y0;
    d.hist.push({ x: e.clientX, y: e.clientY, t: e.timeStamp || performance.now() });
    if (d.hist.length > 6) d.hist.shift();
    setLean(d.card, d.dx, d.dy);
  };
  /** 直近の指の速さ（px/ms） */
  const velocity = (d) => {
    const hst = d.hist;
    if (!hst || hst.length < 2) return { vx: 0, vy: 0 };
    const a = hst[0];
    const b = hst[hst.length - 1];
    const dt = Math.max(1, b.t - a.t);
    return { vx: (b.x - a.x) / dt, vy: (b.y - a.y) / dt };
  };
  const onUp = (e) => {
    const d = L.drag;
    if (!d || d.id !== e.pointerId) return;
    // 差し替えで外れたカードの lostpointercapture は無視する（指はまだ触れている）
    if (e.type === 'lostpointercapture' && !d.card.isConnected) return;
    L.drag = null;
    d.card.classList.remove('is-dragging');
    if (e.type === 'pointerup' && Math.abs(d.dx) >= SWIPE_THRESHOLD) {
      el.classList.remove('lean-yes', 'lean-no', 'is-armed');
      const v = velocity(d);
      decide(d.dx > 0 ? 'right' : 'left', { dx: d.dx, dy: d.dy, vx: v.vx, vy: v.vy });
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
    if (!b) return;
    // ボタンで決めたときも、カードが一瞬その側へ傾いてから飛ぶ
    const top = stack.querySelector('.swipe-card.is-top');
    if (top && !reduce && !L.busy) top.classList.add(b.dataset.dir === 'right' ? 'lean-yes' : 'lean-no');
    decide(b.dataset.dir);
  };

  const add = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    L.offs.push(() => target.removeEventListener(type, fn, opts));
  };
  add(stack, 'pointerdown', onDown);
  add(document, 'pointermove', onMove);
  add(document, 'pointerup', onUp);
  add(document, 'pointercancel', onUp);
  add(stack, 'lostpointercapture', onUp);
  add(el, 'click', onBtn);
  add(document, 'keydown', onKey);

  // 円形のタイマー（演出だけ。残り時間は報酬を変えない）。輪は毎フレームなめらかに減り、数字は 1 秒ごと
  let lastSec = -1;
  const tick = () => {
    if (live !== L || s.done) return;
    const left = Math.max(0, s.deadline - performance.now());
    timerEl.style.setProperty('--p', (left / SWIPE_MS).toFixed(4));
    const sec = Math.ceil(left / 1000);
    if (sec !== lastSec) {
      lastSec = sec;
      textEl.textContent = String(sec);
      if (capEl) capEl.textContent = fill(tx(app, 'photo.timeLeft', '残り {n} 秒'), { n: sec });
      if (sec <= 3 && sec > 0 && textEl.animate && !reduce) textEl.animate([{ transform: 'scale(1.35)' }, { transform: 'none' }], { duration: 300, easing: 'cubic-bezier(.34, 1.56, .64, 1)' });
    }
    el.classList.toggle('is-hurry', left <= 3000);
    if (left <= 0) {
      finish();
      return;
    }
    if (reduce || typeof requestAnimationFrame !== 'function') L.timers.push(setTimeout(tick, 100));
    else L.raf = requestAnimationFrame(tick);
  };
  drawStack(false);
  drawPicks(false);
  // 飛んでいく途中で描き直されて、最後の 1 枚の後始末が流れたときは、ここで確定する
  if (s.i >= cands.length) {
    L.timers.push(setTimeout(finish, 0));
    return;
  }
  // 初めて出たときだけ、カードが下から配られる
  if (!s.dealt) {
    s.dealt = true;
    if (!reduce) {
      const cards = [...stack.querySelectorAll('.swipe-card')].reverse().slice(0, 4);
      cards.forEach((c, i) => c.animate && c.animate([
        { transform: `translateY(120px) rotate(${i % 2 ? 7 : -7}deg)`, opacity: 0 },
        { transform: 'none', opacity: 1 },
      ], { duration: 420, delay: 80 + (cards.length - 1 - i) * 70, easing: 'cubic-bezier(.16, 1, .3, 1)', fill: 'backwards' }));
    }
  }
  resumeDrag();
  tick();
}

function unmountSwipe() {
  if (!live) return;
  // 指が触れたままの途中状態は app.ui.swipe に預け、次の mount で拾い直す
  const d = live.drag;
  const sw = live.s;
  sw.drag = d && !sw.done ? { id: d.id, x0: d.x0, y0: d.y0, dx: d.dx, dy: d.dy } : null;
  if (sw.drag) {
    // 描き直しまでの間に指が離れたら、預けた途中状態は捨てる（戻ったカードが傾いたまま残らないように）
    const drop = (e) => {
      if (sw.drag && e.pointerId === sw.drag.id) sw.drag = null;
      document.removeEventListener('pointerup', drop, true);
      document.removeEventListener('pointercancel', drop, true);
    };
    document.addEventListener('pointerup', drop, true);
    document.addEventListener('pointercancel', drop, true);
  }
  for (const off of live.offs) off();
  for (const id of live.timers) clearTimeout(id);
  if (live.raf) cancelAnimationFrame(live.raf);
  live = null;
}

// ------------------------------------------------------------

/** 1 つ前へ: 「手に入れた」を出していれば閉じて一覧（か次のスワイプ）へ、それ以外はホームへ */
function back(app) {
  if (app.ui.photoGot) { app.ui.photoGot = null; renderApp(); return; }
  go('home');
}

export function render(app) {
  const p = extPending(app);
  let body;
  // 手に入れたものを先に見せる（続けてもう 1 回あるときは、閉じると次のスワイプ）
  if (app.ui.photoGot) body = gotView(app, app.ui.photoGot);
  else if (p) body = swipeView(app, p);
  else body = gallery(app);
  const mode = app.ui.photoGot ? 'got' : p ? 'swipe' : 'gallery';
  // ナビの案内パネルは出さない（スワイプ中に吹き出しが伸びて配置が動くのを避ける）。全文は「?」の頭
  const root = h('section', { class: ['app-screen', 'app-screen--photo', 'photo', `photo--${mode}`, mode === 'swipe' ? 'is-swiping' : null], dataset: { mode } },
    appHead(app, { title: t(app, 'app.photo'), sub: t(app, 'photo.title'), help: () => openHelp(app), back: () => back(app) }),
    body);
  return root;
}

/** 前回描いたときの表示（一覧に戻ってきたときにシャッターを切るため） */
let lastMode = null;

export function mount(app, el) {
  if (!el) return;
  const enter = entering('photo');
  const mode = el.dataset.mode;
  const fresh = enter || lastMode !== mode;
  lastMode = mode;
  if (mode === 'gallery' && fresh && !reducedMotion()) {
    el.classList.add('is-enter');
    setTimeout(() => el.classList.remove('is-enter'), 1400);
  }
  if (mode === 'got') playGot(el);
  const p = extPending(app);
  if (!p || app.ui.photoGot) return;
  const sw = el.querySelector('.swipe');
  if (sw) mountSwipe(app, sw, p);
}

export function unmount(app, el) {
  unmountSwipe();
  // ほかのアプリへ移るときは「手に入れた」の表示を閉じる（スワイプの進み具合と持ち時間は残す）
  if (app && app.ui.app !== 'photo') {
    app.ui.photoGot = null;
    leave('photo');
    lastMode = null;
  }
}
