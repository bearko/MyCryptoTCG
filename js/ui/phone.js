// phone.js — スマホの外枠・ステータスバー・ホーム・通知・下のホームボタン（SPEC-111 §2）
//
// 数値・判定はエンジンに聞く（season.battery / dayOfWeek / seasonOf）。ここは描くだけ。

import { h, clear, imgEl, landAssetPath } from './h.js';
import { uiText } from '../engine/lines.js';
import { battery, dayOfWeek, seasonOf } from '../engine/season.js';
import { go, endTurn, giveUp, openPopup, closePopup, getApp, pendingApp, skipExecute } from '../main.js';
import { isSoundOn, setSound, playBgm } from './audio.js';

/** ホームに並べるアプリ（この順で 3 列） */
export const APPS = ['map', 'chat', 'calendar', 'drive', 'photo'];

/** ホームの通知の一覧に出す数 */
const NOTICE_LIST_MAX = 30;

const t = (app, key) => uiText(app.db, key);

/**
 * #app の中に .phone の外枠を 1 度だけ作る。
 * @returns {{phone, status, screen, execbar, homebar}}
 */
export function ensureShell(root) {
  let phone = root.querySelector(':scope > .phone');
  if (!phone) {
    clear(root);
    phone = h('div', { class: 'phone' },
      h('header', { class: 'phone__status', role: 'banner' }),
      h('main', { class: 'phone__screen', id: 'screen' }),
      h('div', { class: 'phone__execbar' }),
      h('nav', { class: 'phone__homebar' }));
    root.appendChild(phone);
  }
  return {
    phone,
    status: phone.querySelector('.phone__status'),
    screen: phone.querySelector('.phone__screen'),
    execbar: phone.querySelector('.phone__execbar'),
    homebar: phone.querySelector('.phone__homebar'),
  };
}

// ------------------------------------------------------------
// ステータスバー（Day / 曜日 / 季節 / バッテリー）
// ------------------------------------------------------------

export function renderStatusBar(app, el) {
  clear(el);
  const st = app.state;
  if (!st) {
    el.appendChild(h('span', { class: 'status__left' }, 'MyCryptoWars'));
    return;
  }
  const day = Math.min(st.day, 28);
  const left = h('span', { class: 'status__left num' },
    `${t(app, 'status.day')} ${day}`, h('span', { class: 'status__sep', 'aria-hidden': 'true' }, '・'),
    t(app, `dow.${dayOfWeek(day)}`), h('span', { class: 'status__sep', 'aria-hidden': 'true' }, '・'),
    t(app, `season.${seasonOf(day)}`));
  const pct = battery(st.day);
  const low = pct <= 20;
  const bat = h('span', { class: ['status__battery', low ? 'is-low' : null], 'aria-label': `${t(app, 'status.battery')} ${pct}%` },
    h('span', { class: 'num' }, `${pct}%`),
    h('span', { class: 'battery', 'aria-hidden': 'true' }, h('span', { class: 'battery__fill', style: { width: `${pct}%` } })));
  el.appendChild(left);
  el.appendChild(bat);
}

// ------------------------------------------------------------
// 下のホームボタン
// ------------------------------------------------------------

export function renderHomeBar(app, el) {
  clear(el);
  const disabled = !app.state || app.ui.executing || app.ui.app === 'result';
  el.appendChild(h('button', {
    class: 'homebar__btn', type: 'button', 'aria-label': t(app, 'app.home'), disabled,
    onClick: () => go('home'),
  }, h('span', { class: 'homebar__pill', 'aria-hidden': 'true' })));
}

// ------------------------------------------------------------
// 実行フェーズの「スキップ」（右上）
// ------------------------------------------------------------

export function renderExecuteBar(app, el) {
  clear(el);
  if (!app.ui.executing) return;
  el.appendChild(h('div', { class: 'execbar' },
    h('span', { class: 'execbar__label' }, t(app, 'app.execute')),
    h('button', { class: 'btn-secondary execbar__skip', type: 'button', onClick: () => skipExecute() }, t(app, 'execute.skip'))));
}

// ------------------------------------------------------------
// バッジ
// ------------------------------------------------------------

/** アプリごとの未読の通知数と、選択待ちがあるか */
export function badgeOf(app, appName) {
  const st = app.state;
  if (!st) return { count: 0, pending: false };
  const seen = app.ui.seen[appName] || 0;
  let count = 0;
  for (const n of st.notices || []) if (n.app === appName && n.id > seen) count++;
  return { count, pending: pendingApp() === appName };
}

// ------------------------------------------------------------
// ホーム
// ------------------------------------------------------------

function landDef(app, id) {
  return (app.db.lands || []).find((l) => l.id === id) || null;
}

function appIcon(app, name) {
  const b = badgeOf(app, name);
  const label = t(app, `app.${name}`);
  const badge = b.pending ? h('span', { class: 'badge badge--pending', 'aria-label': t(app, 'home.pending') }, '!')
    : b.count > 0 ? h('span', { class: 'badge num', 'aria-label': `未読 ${b.count}` }, b.count > 9 ? '9+' : String(b.count))
      : null;
  return h('button', { class: 'app-icon', type: 'button', dataset: { app: name }, onClick: () => go(name) },
    h('span', { class: 'app-icon__tile', 'aria-hidden': 'true' }, h('span', { class: `app-icon__shape app-icon__shape--${name}` })),
    h('span', { class: 'app-icon__label' }, label.replace(/^MCH /, '')),
    badge);
}

function noticeItem(app, n) {
  const fresh = n.id >= (app.ui.lastBatch || Infinity);
  const target = n.app || (n.tile != null ? 'map' : null);
  const body = [
    h('span', { class: 'notice__day num' }, `${t(app, 'status.day')} ${n.day}`),
    h('span', { class: 'notice__text' }, n.text),
    target ? h('span', { class: 'notice__app' }, t(app, `app.${target}`).replace(/^MCH /, '')) : null,
  ];
  if (!target) return h('li', { class: ['notice', fresh ? 'is-new' : null] }, body);
  return h('li', { class: ['notice', fresh ? 'is-new' : null] },
    h('button', { class: 'notice__btn', type: 'button', onClick: () => go(target, n.tile != null ? { tile: n.tile } : {}) }, body));
}

function resRow(app, land) {
  const keys = ['gum', 'food', 'mat', 'pop'];
  return h('dl', { class: 'res-row' }, keys.map((k) => h('div', { class: 'res' },
    h('dt', null, t(app, `res.${k}`)),
    h('dd', { class: 'num' }, String(Math.floor((land.res && land.res[k]) || 0))))));
}

export const homeView = {
  render(app) {
    const st = app.state;
    const me = st.lands[st.playerLand];
    const def = landDef(app, st.playerLand) || { id: st.playerLand, nameJa: st.playerLand, color: '#c4a35a' };
    const notices = (st.notices || []).slice(-NOTICE_LIST_MAX).reverse();
    const pa = pendingApp();

    return h('section', { class: 'home', style: { '--land': def.color } },
      h('div', { class: 'home__land' },
        imgEl(landAssetPath(def.icon), def.nameJa || def.name, { class: 'home__land-icon' }),
        h('div', { class: 'home__land-text' },
          h('span', { class: 'home__land-name' }, def.nameJa || def.name),
          h('span', { class: 'home__land-sub muted num' }, `${t(app, 'drive.fortPoints')} ${me.fortPoints || 0}`)),
        h('button', { class: 'btn-ghost home__settings', type: 'button', onClick: () => openSettings(app) }, t(app, 'common.settings'))),
      resRow(app, me),
      h('div', { class: 'home__apps' }, APPS.map((a) => appIcon(app, a))),
      pa ? h('button', { class: 'home__pending btn-secondary', type: 'button', onClick: () => go(pa) }, t(app, 'home.pending')) : null,
      h('section', { class: 'home__notices', 'aria-labelledby': 'home-notices-title' },
        h('h2', { class: 'section-title', id: 'home-notices-title' }, t(app, 'home.notices')),
        notices.length
          ? h('ul', { class: 'notice-list' }, notices.map((n) => noticeItem(app, n)))
          : h('p', { class: 'empty muted' }, t(app, 'home.noNotices'))),
      h('div', { class: 'home__actions' },
        h('button', { class: 'btn-danger home__giveup', type: 'button', onClick: () => giveUp() }, t(app, 'common.giveup')),
        h('button', { class: 'btn-primary home__end', type: 'button', onClick: () => endTurn() }, t(app, 'home.endTurn'))));
  },
};

// ------------------------------------------------------------
// 設定（音）
// ------------------------------------------------------------

export function openSettings(app = getApp()) {
  const body = h('div', { class: 'settings' });
  const draw = () => {
    clear(body);
    const on = isSoundOn();
    body.appendChild(h('div', { class: 'setting-row' },
      h('span', { id: 'setting-sound' }, t(app, 'common.sound')),
      h('button', {
        class: ['switch', on ? 'is-on' : null], type: 'button', role: 'switch', 'aria-checked': on ? 'true' : 'false', 'aria-labelledby': 'setting-sound',
        onClick: () => {
          setSound(!on);
          if (!on) playBgm(app.ui.executing ? 'battle' : 'land');
          draw();
        },
      }, h('span', { class: 'switch__knob', 'aria-hidden': 'true' }), h('span', { class: 'switch__text' }, on ? t(app, 'common.on') : t(app, 'common.off')))));
    body.appendChild(h('div', { class: 'btn-row' },
      h('button', { class: 'btn-secondary', type: 'button', onClick: () => closePopup() }, t(app, 'common.close'))));
  };
  draw();
  openPopup(body, { title: t(app, 'common.settings') });
}
