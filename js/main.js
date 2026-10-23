// main.js — 起動・画面の切り替え・ターンの進行（UI 側の司令塔。SPEC-110 §4・SPEC-111 §8）
//
// app = { db, state, ui, rng }。ゲームのルールはここに書かない（engine の関数を呼ぶだけ）。
//
// ビュー（js/ui/*-view.js と phone.js の homeView）の約束:
//   render(app) → HTMLElement            必須。画面領域（.phone__screen）に差す
//   mount(app, el) / unmount(app, el)    任意。差した直後 / 外す直前
//   onEvent(app, ev)                     任意。実行フェーズの 1 歩ごとのイベント（無ければ main が最小限の演出）
//   onExecuteEnd(app)                    任意。実行フェーズが終わった（スキップも含む）

import { loadDb } from './data.js';
import { newGame, save, load, clearSave } from './state.js';
import { makeRng } from './engine/rng.js';
import { toPixel } from './engine/hex.js';
import { planCpu, execute, beginTurn, noticesFrom } from './engine/turn.js';
import { uiText } from './engine/lines.js';
import { h, clear, toast, band, reducedMotion } from './ui/h.js';
import * as phone from './ui/phone.js';
import * as landSelect from './ui/land-select-view.js';
import * as resultView from './ui/result-view.js';
import * as mapView from './ui/map-view.js';
import * as chatView from './ui/chat-view.js';
import * as calendarView from './ui/calendar-view.js';
import * as driveView from './ui/drive-view.js';
import * as photoView from './ui/photo-view.js';
import { playBgm, playSe } from './ui/audio.js';
import * as fx from './ui/fx.js';
import * as ambient from './ui/ambient.js';

/** 実行フェーズの 1 歩（ms） */
export const STEP_MS = 350;
/** ホームの通知を残す数 */
export const MAX_NOTICES = 80;
/** 地図のカメラの基準（zoom 1 の 1 ヘックス） */
export const HEX_SIZE = 28;

const VIEWS = {
  home: phone.homeView,
  land: landSelect,
  result: resultView,
  map: mapView,
  chat: chatView,
  calendar: calendarView,
  drive: driveView,
  photo: photoView,
};

/** 起動前でも参照できるように、形だけ先に作る */
const app = {
  db: null,
  state: null,
  rng: null,
  ui: {
    app: 'land',
    selectedSquad: null,
    chatSquad: null,
    // mapCam.x / y: カメラの中心のワールド座標（zoom 1・HEX_SIZE 基準のピクセル。hex.toPixel と同じ）
    mapCam: { x: 0, y: 0, zoom: 1 },
    tile: null,            // 選んでいるタイル（Map で寄る先）
    popup: null,           // 開いているポップアップの要素
    executing: false,      // 実行フェーズの最中
    seen: {},              // アプリごとに既読にした通知 id の最大
    lastBatch: 0,          // 直近のターン終了で積んだ通知の最初の id
  },
};

let current = null; // { name, view, el }
let exec = null;    // { gen, events, skip, timer }

export function getApp() {
  return app;
}

/** 地図のカメラをタイルの中心に寄せる */
export function focusTile(tileIdx) {
  const st = app.state;
  if (!st || tileIdx == null || tileIdx < 0) return;
  const w = st.map.w;
  const p = toPixel(tileIdx % w, Math.floor(tileIdx / w), HEX_SIZE);
  app.ui.mapCam.x = p.x;
  app.ui.mapCam.y = p.y;
  app.ui.tile = tileIdx;
}

function maxNoticeId() {
  let m = 0;
  for (const n of (app.state && app.state.notices) || []) if (n.id > m) m = n.id;
  return m;
}

/** そのアプリ宛ての通知を既読にする */
function markSeen(appName) {
  app.ui.seen[appName] = maxNoticeId();
}

function resetUiForState() {
  const st = app.state;
  app.ui.selectedSquad = null;
  app.ui.chatSquad = null;
  app.ui.tile = null;
  app.ui.executing = false;
  app.ui.mapCam = { x: 0, y: 0, zoom: 1 };
  app.ui.seen = {};
  app.ui.lastBatch = 0;
  if (st) {
    const m = maxNoticeId();
    for (const k of Object.keys(VIEWS)) app.ui.seen[k] = m;
    const home = st.lands[st.playerLand] && st.lands[st.playerLand].home;
    if (home != null) focusTile(home);
    app.ui.tile = null;
  }
}

// ------------------------------------------------------------
// 起動
// ------------------------------------------------------------

export async function boot() {
  const root = document.getElementById('app');
  try {
    app.db = await loadDb('./data/');
  } catch (e) {
    console.error(e);
    const old = document.querySelector('.boot');
    if (old) old.remove();
    if (root) {
      clear(root);
      root.appendChild(h('div', { class: 'boot boot--error', role: 'alert' }, 'データを読み込めませんでした。再読み込みしてください。'));
    }
    return;
  }
  document.addEventListener('keydown', onKeydown);
  fx.install();
  document.addEventListener('pointerdown', rememberPress, { capture: true, passive: true });
  const saved = load();
  if (saved) {
    app.state = saved;
    resetUiForState();
    app.rng = rngFor(saved);
    go(saved.ended ? 'result' : 'home');
  } else {
    app.state = null;
    go('land');
  }
  const bootEl = document.querySelector('.boot');
  if (bootEl) {
    if (reducedMotion() || !bootEl.animate) bootEl.remove();
    else bootEl.animate([{ opacity: 1 }, { opacity: 0, filter: 'blur(4px)' }], { duration: 360, easing: 'ease-out', fill: 'forwards' }).finished.then(() => bootEl.remove(), () => bootEl.remove());
  }
  playBgm('land');
}

/** ランド選択から呼ぶ。新しいゲームを始めてホームへ */
export function startGame(playerLand, seed) {
  app.state = newGame({ seed, playerLand, db: app.db });
  resetUiForState();
  app.rng = rngFor(app.state);
  save(app.state);
  go('home');
}

/** 結果画面の「もう一度」。セーブを消してランド選択へ */
export function restart() {
  clearSave();
  app.state = null;
  resetUiForState();
  go('land');
}

function rngFor(state) {
  return makeRng((state.seed + state.day * 1000) >>> 0);
}

// ------------------------------------------------------------
// 画面の切り替え
// ------------------------------------------------------------

/**
 * 画面を切り替える。
 * @param {string} appName "home"|"map"|"chat"|"calendar"|"drive"|"photo"|"land"|"result"
 * @param {{tile?:number, squad?:string}} [opts] tile があれば Map でそこへ寄る。squad があれば選択する
 */
export function go(appName, opts = {}) {
  if (!VIEWS[appName]) appName = app.state ? 'home' : 'land';
  if (!app.state && appName !== 'land') appName = 'land';
  closePopup();
  if (opts.tile != null) focusTile(opts.tile);
  if (opts.squad != null) {
    app.ui.selectedSquad = opts.squad;
    app.ui.chatSquad = opts.squad;
  }
  app.ui.app = appName;
  if (app.state) markSeen(appName);
  render();
}

/** 現在のアプリを描き直す（ステータスバー・ホームボタンも）。アプリが変わったときは切り替えの動きを付ける */
export function render() {
  const root = document.getElementById('app');
  if (!root) return;
  const shell = phone.ensureShell(root);
  ambient.attach(shell.phone);
  phone.renderStatusBar(app, shell.status);
  phone.renderHomeBar(app, shell.homebar);
  shell.phone.dataset.app = app.ui.app;
  shell.phone.classList.toggle('is-executing', !!app.ui.executing);
  ambient.setScene({ app: app.ui.app, color: sceneColor() });
  // 机（880px 以上の端末の周り）も自ランドの色で照らす
  document.documentElement.style.setProperty('--scene', sceneColor());

  const prev = current;
  const changed = !!prev && prev.name !== app.ui.app;
  if (prev && prev.view.unmount) {
    try { prev.view.unmount(app, prev.el); } catch (e) { console.error(e); }
  }
  const view = VIEWS[app.ui.app];
  let el;
  try {
    el = view.render(app);
  } catch (e) {
    console.error(e);
    el = h('section', { class: 'app-screen' }, h('p', { class: 'muted' }, 'この画面を描けませんでした。'));
  }
  // 切り替えの準備: 消える画面を写しとして残す（押した場所を先に測る）
  const plan = changed ? planTransition(shell, prev, app.ui.app) : null;
  clear(shell.screen);
  if (el) shell.screen.appendChild(el);
  if (changed) shell.screen.scrollTop = 0;
  current = { name: app.ui.app, view, el };
  if (view.mount) {
    try { view.mount(app, el); } catch (e) { console.error(e); }
  }
  phone.renderExecuteBar(app, shell.execbar);
  if (plan) runTransition(shell, plan, el);
}

// ------------------------------------------------------------
// 画面の切り替えの動き（SPEC-112 §1 C）
//   ホーム → アプリ: アイコン（押したもの）の位置から広がって開く
//   アプリ → ホーム: 消える画面がそのアプリのアイコンへ縮んで戻る
//   そのほか: 押した場所から広がる（押した場所が無ければ横にすべって入る）
// 大きさと位置は変えない（clip-path だけ）ので、動いている最中も押せる・寸法を測れる。
// ------------------------------------------------------------

/** 直近に押したもの（押した場所からアプリを開くため） */
let lastPress = null;
/** 今残っている写し */
let activeGhost = null;

function rememberPress(e) {
  const t = e.target instanceof Element ? e.target.closest('button, [role="button"], a[href]') : null;
  lastPress = t ? { el: t, at: performance.now() } : null;
}

function sceneColor() {
  if (!app.state || !app.db) return '#c4a35a';
  const def = (app.db.lands || []).find((l) => l.id === app.state.playerLand);
  return (def && def.color) || '#c4a35a';
}

function dropGhost() {
  if (activeGhost) {
    activeGhost.getAnimations?.().forEach((a) => a.cancel());
    activeGhost.remove();
    activeGhost = null;
  }
}

/** 消える画面を、画面領域と同じ位置の写しに移す */
function makeGhost(shell, el, below) {
  const scr = shell.screen;
  const g = h('div', { class: ['phone__ghost', below ? 'phone__ghost--plain' : null], 'aria-hidden': 'true', inert: true });
  g.style.left = `${scr.offsetLeft}px`;
  g.style.top = `${scr.offsetTop}px`;
  g.style.width = `${scr.offsetWidth}px`;
  g.style.height = `${scr.offsetHeight}px`;
  if (below) g.style.zIndex = '1';
  const top = scr.scrollTop;
  g.appendChild(el);
  shell.phone.insertBefore(g, below ? scr : shell.execbar);
  g.scrollTop = top;
  activeGhost = g;
  return g;
}

function planTransition(shell, prev, next) {
  dropGhost();
  if (!prev || !prev.el || !prev.el.isConnected || reducedMotion()) return { next, ghost: null };
  let fromRect = null;
  if (prev.name === 'home') {
    const icon = prev.el.querySelector(`.app-icon[data-app="${next}"] .app-icon__tile`);
    if (icon) fromRect = icon.getBoundingClientRect();
  }
  if (!fromRect && lastPress && performance.now() - lastPress.at < 900 && prev.el.contains(lastPress.el)) {
    fromRect = lastPress.el.getBoundingClientRect();
  }
  const toHome = next === 'home' && prev.name !== 'land' && prev.name !== 'result';
  const mode = toHome ? 'close' : fromRect ? 'open' : 'slide';
  const ghost = makeGhost(shell, prev.el, mode === 'open');
  return { next, from: prev.name, mode, fromRect, ghost };
}

function runTransition(shell, plan, el) {
  lastPress = null;
  if (!plan.ghost) return;
  const ghost = plan.ghost;
  const done = () => { if (activeGhost === ghost) activeGhost = null; ghost.remove(); };
  playSe(plan.mode === 'close' ? 'close' : 'open');
  if (plan.mode === 'open') {
    // 奥の画面は少し沈んで消え、新しい画面が押した場所から広がる
    const ms = fx.token('--t-flip', 380);
    ghost.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.96)', filter: 'blur(2px)' }],
      { duration: ms, easing: 'cubic-bezier(.16, 1, .3, 1)', fill: 'forwards' }).finished.then(done, done);
    fx.flipOpen(shell.screen, plan.fromRect, { radius: 16 });
    return;
  }
  if (plan.mode === 'close') {
    // 消える画面はアイコンへ縮む。ホームは少し奥から手前へ
    const icon = el && el.querySelector(`.app-icon[data-app="${plan.from}"] .app-icon__tile`);
    const toRect = icon ? icon.getBoundingClientRect() : null;
    if (toRect) {
      fx.flipClose(ghost, toRect, { radius: 16 }).then(done, done);
      if (icon) icon.animate([{ transform: 'scale(1.18)', filter: 'brightness(1.6)' }, { transform: 'none', filter: 'none' }],
        { duration: 420, delay: fx.token('--t-flip', 380) * 0.6, easing: 'cubic-bezier(.34, 1.56, .64, 1)' });
    } else {
      ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards' }).finished.then(done, done);
    }
    if (el && el.animate) el.animate([{ transform: 'scale(1.04)', opacity: 0.6 }, { transform: 'none', opacity: 1 }], { duration: fx.token('--t-flip', 380), easing: 'cubic-bezier(.16, 1, .3, 1)' });
    return;
  }
  // すべって入れ替わる
  ghost.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(-24px)' }],
    { duration: fx.token('--t-ui', 240), easing: 'cubic-bezier(.16, 1, .3, 1)', fill: 'forwards' }).finished.then(done, done);
  if (el) fx.slideIn(el, 1, { distance: 32 });
}

// ------------------------------------------------------------
// ポップアップ（1 つずつ。閉じる・背景・Esc で閉じる）
// ------------------------------------------------------------

/**
 * ポップアップを開く（開いていたものは閉じる）。
 * @param {HTMLElement} content 中身
 * @param {{title?:string, onClose?:Function, closable?:boolean}} [opts]
 */
export function openPopup(content, opts = {}) {
  // 前のポップアップは退場の動きを待たずにすぐ外す（閉じかけの写しが新しいものの奥に透けないように）
  closePopup({ instant: true });
  for (const g of document.querySelectorAll('body > .popup-ghost')) g.remove();
  const closable = opts.closable !== false;
  const titleId = 'popup-title-' + Date.now();
  const card = h('div', { class: 'popup__card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': opts.title ? titleId : null },
    h('header', { class: 'popup__head' },
      opts.title ? h('h2', { class: 'popup__title', id: titleId }, opts.title) : h('span'),
      closable ? h('button', { class: 'popup__x btn-ghost', type: 'button', 'aria-label': t('common.close'), onClick: () => closePopup() }, '×') : null),
    h('div', { class: 'popup__body' }, content));
  const backdrop = h('div', { class: 'popup', onClick: (e) => { if (closable && e.target === backdrop) closePopup(); } }, card);
  backdrop._onClose = opts.onClose || null;
  backdrop._closable = closable;
  document.body.appendChild(backdrop);
  app.ui.popup = backdrop;
  // 初めの手元は主役のボタン（OK など）。危ない操作（ギブアップ）は誤って Enter で決めないよう、
  // どのボタンにも置かずダイアログそのものへ。どちらでもなければ最初の入力・ボタン
  let focusable = null;
  if (opts.focus === 'dialog' || card.querySelector('.btn-danger')) {
    card.tabIndex = -1;
    focusable = card;
  } else {
    focusable = card.querySelector('.btn-primary:not(:disabled)')
      || card.querySelector('input, select, textarea')
      || card.querySelector('button:not(.popup__x), [href], [tabindex]')
      || card.querySelector('button');
  }
  if (focusable) focusable.focus({ preventScroll: true });
  return backdrop;
}

/** @param {{instant?:boolean}} [opts] instant なら退場の動きを付けずにすぐ外す */
export function closePopup(opts = {}) {
  const p = app.ui.popup;
  if (!p) return;
  app.ui.popup = null;
  // 閉じる動き: 写し（.popup-ghost。押せない）に変えて、沈みながら消す
  if (opts.instant || reducedMotion()) p.remove();
  else {
    p.classList.replace('popup', 'popup-ghost');
    p.setAttribute('aria-hidden', 'true');
    setTimeout(() => p.remove(), 190);
  }
  if (p._onClose) {
    try { p._onClose(); } catch (e) { console.error(e); }
  }
}

function onKeydown(e) {
  if (e.key === 'Escape' && app.ui.popup && app.ui.popup._closable) {
    e.preventDefault();
    closePopup();
  }
}

/** 確認のポップアップ（OK / キャンセル） */
export function confirmPopup(text, onOk, opts = {}) {
  const body = h('div', { class: 'confirm' },
    h('p', null, text),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn-secondary btn-secondary--quiet', type: 'button', onClick: () => closePopup() }, t('common.cancel')),
      h('button', { class: opts.danger ? 'btn-danger' : 'btn-primary', type: 'button', onClick: () => { closePopup(); onOk(); } }, opts.okText || t('common.ok'))));
  return openPopup(body, { title: opts.title || t('common.confirm') });
}

function t(key) {
  return uiText(app.db, key);
}

// ------------------------------------------------------------
// ターン終了（SPEC-111 §8）
// ------------------------------------------------------------

/** プレイヤーの選択待ち（あれば誘導先のアプリ名） */
export function pendingApp() {
  const st = app.state;
  if (!st) return null;
  const p = (st.pending || []).find((x) => x.land === st.playerLand);
  if (!p) return null;
  return p.kind === 'soul' ? 'drive' : p.kind === 'extension' ? 'photo' : null;
}

export function isExecuting() {
  return !!exec;
}

export function endTurn() {
  const st = app.state;
  if (!st || exec) return;
  if (st.ended) {
    go('result');
    return;
  }
  // 1. 選択待ちが残っていれば、そちらへ誘導して止める
  const pa = pendingApp();
  if (pa) {
    toast(t('home.pending'), { key: 'pending' });
    go(pa);
    return;
  }
  // 2. CPU の指示 → 3. 実行
  const rng = rngFor(st);
  app.rng = rng;
  planCpu(st, app.db, rng);
  exec = { gen: execute(st, app.db, rng), events: [], skip: false, timer: null, toastKey: null };
  app.ui.executing = true;
  app.ui.selectedSquad = null;
  playBgm('battle');
  go('map');
  if (reducedMotion()) {
    // 動きを減らす設定でも 1 歩ずつ出すが、演出の間は短く
    exec.stepMs = 120;
  }
  scheduleStep();
}

/** 「スキップ」。残りを同期で回し切る */
export function skipExecute() {
  if (!exec) return;
  exec.skip = true;
  if (exec.timer) clearTimeout(exec.timer);
  exec.timer = null;
  drain();
}

function scheduleStep() {
  if (!exec) return;
  exec.timer = setTimeout(step, exec.stepMs || STEP_MS);
}

function step() {
  if (!exec || exec.skip) return;
  exec.timer = null;
  let r;
  try {
    r = exec.gen.next();
  } catch (e) {
    console.error(e);
    finishExecute();
    return;
  }
  // 霧の向こうの CPU の動きなど、プレイヤーに見えないイベントは待たずに進める
  // （1 歩 350ms を全部待つと、自分の部隊が 10 秒に 1 回しか動かないように見えるため）
  let guard = 0;
  while (!r.done && !isVisibleEvent(r.value) && guard < 500) {
    exec.events.push(r.value);
    guard += 1;
    try { r = exec.gen.next(); } catch (e) { console.error(e); finishExecute(); return; }
  }
  if (r.done) {
    finishExecute();
    return;
  }
  exec.events.push(r.value);
  dispatchEvent(r.value);
  scheduleStep();
}

const ALWAYS_VISIBLE = new Set(['fort_fallen', 'home_fallen', 'clear', 'week_end', 'season_end', 'soul', 'extension_offer']);

/** 演出として見せるイベントか（自ランドに関わるもの・探索済みのタイルで起きたもの） */
function isVisibleEvent(ev) {
  if (ALWAYS_VISIBLE.has(ev.t)) return true;
  const st = app.state;
  const me = st.playerLand;
  if (ev.land) return ev.land === me && ev.t !== 'yield';
  const ids = [ev.squad, ev.attacker, ev.defender].filter(Boolean);
  if (ids.some((id) => st.squads[id] && st.squads[id].land === me)) return true;
  const explored = exploredSet(st, me);
  const tiles = [ev.to, ev.from, ev.at, ev.tile].filter((x) => typeof x === 'number');
  return tiles.some((i) => explored.has(i));
}

let exploredCache = { day: -1, set: new Set() };
function exploredSet(st, me) {
  if (exploredCache.day !== st.day || exploredCache.land !== me) {
    exploredCache = { day: st.day, land: me, set: new Set(st.lands[me].explored) };
  }
  return exploredCache.set;
}

function drain() {
  try {
    for (let r = exec.gen.next(); !r.done; r = exec.gen.next()) exec.events.push(r.value);
  } catch (e) {
    console.error(e);
  }
  finishExecute();
}

/** 1 歩のイベントを今のビューへ。ビューに onEvent が無ければ最小限の演出 */
function dispatchEvent(ev) {
  if (ev.t === 'battle') playSe('hit');
  else if (ev.t === 'fort_fallen') playSe('fort');
  const view = current && current.view;
  // 陥落: 全画面のカットインはプレイヤーのランドが関わるときだけ（敵どうしは細い帯。fx.cutin）
  const scoped = ev.t === 'fort_fallen' || ev.t === 'home_fallen';
  if (scoped) fx.pushCutinScope(involvesPlayer(ev));
  try {
    if (view && typeof view.onEvent === 'function') {
      try { view.onEvent(app, ev); } catch (e) { console.error(e); }
      return;
    }
    fallbackEvent(ev);
  } finally {
    if (scoped) fx.settleCutinScope();
  }
}

/** 陥落がプレイヤーのランドに関わるか（自分が落とした / 自分の砦・本拠地が落とされた） */
function involvesPlayer(ev) {
  const me = app.state && app.state.playerLand;
  if (!me) return true;
  return ev.by === me || ev.from === me || ev.land === me;
}

const BAND_EVENTS = new Set(['fort_fallen', 'home_fallen', 'clear']);
const TOAST_EVENTS = new Set(['claim', 'build_start', 'build_done', 'domestic', 'rest', 'yield', 'week_end']);

function fallbackEvent(ev) {
  const st = app.state;
  if (BAND_EVENTS.has(ev.t)) {
    const n = noticesFrom(st, app.db, [ev]);
    band(n[0] ? n[0].text : t(`app.execute`));
    return;
  }
  if (!TOAST_EVENTS.has(ev.t)) return;
  const n = noticesFrom(st, app.db, [ev]);
  if (n[0]) toast(n[0].text, { key: `ev-${ev.t}` });
}

function finishExecute() {
  const st = app.state;
  const events = exec ? exec.events : [];
  const view = current && current.view;
  exec = null;
  app.ui.executing = false;
  fx.clearCutinScopes();
  if (view && typeof view.onExecuteEnd === 'function') {
    try { view.onExecuteEnd(app); } catch (e) { console.error(e); }
  }
  // 4. 通知を積む
  const fresh = noticesFrom(st, app.db, events);
  if (!st.notices) st.notices = [];
  st.notices.push(...fresh);
  if (st.notices.length > MAX_NOTICES) st.notices.splice(0, st.notices.length - MAX_NOTICES);
  app.ui.lastBatch = fresh.length ? fresh[0].id : maxNoticeId() + 1;
  // Chat がヒーローの報告（守り切った・敗走した など）を吹き出しにする
  app.ui.lastEvents = events;
  playBgm('land');
  if (st.ended) {
    st.phase = 'ended';
    save(st);
    playSe(st.ended.winner === st.playerLand ? 'win' : 'lose');
    go('result');
    return;
  }
  beginTurn(st, app.db);
  app.rng = rngFor(st);
  save(st);
  // 新しい通知は各アプリの既読より id が大きいので、アプリを開くまでバッジが付く
  go('home');
  const pa = pendingApp();
  if (pa) toast(t('home.pending'), { key: 'pending' });
}

/** ギブアップ（確認つき） */
export function giveUp() {
  const st = app.state;
  if (!st || exec) return;
  confirmPopup(t('common.giveupConfirm'), () => {
    st.ended = { reason: 'giveup', winner: null };
    st.phase = 'ended';
    save(st);
    playSe('lose');
    go('result');
  }, { danger: true, okText: t('common.giveup'), title: t('common.giveup') });
}

if (typeof document !== 'undefined' && document.getElementById('app')) {
  boot();
}
