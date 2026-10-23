// phone.js — スマホの外枠・ステータスバー・ホーム・通知・下のホームボタン（SPEC-111 §2・SPEC-112 §2）
//
// 数値・判定はエンジンに聞く（season.battery / dayOfWeek / seasonOf、economy.yields / upkeep、orders.apMax / validate）。
// ここは描くだけ。食料の見込みは「1 日の産出 − 1 日の消費」をエンジンに聞いて並べるだけで、新しいルールは書かない。
//
// ホームの層（SPEC-112 §2 B）: 奥に壁紙（自ランドのクリプタイド。ぼかして漂う）→ 吹き出し → ナビゲーターの立ち絵
// （吹き出しの端に重なる）→ 「今日のやること」の板（立ち絵の足元を隠す）。

import { h, clear, imgEl, landAssetPath, heroImg } from './h.js';
import { uiText } from '../engine/lines.js';
import { battery, dayOfWeek, seasonOf } from '../engine/season.js';
import { yields, upkeep } from '../engine/economy.js';
import { apMax, validate } from '../engine/orders.js';
import { go, endTurn, giveUp, openPopup, closePopup, getApp, pendingApp, skipExecute } from '../main.js';
import { isSoundOn, setSound, playBgm } from './audio.js';
import { img } from '../constants.js';
import * as fx from './fx.js';

/** ホームに並べるアプリ（この順で 1 列のドック） */
export const APPS = ['map', 'chat', 'calendar', 'drive', 'photo'];

/** ホームの通知の一覧に出す数 */
const NOTICE_LIST_MAX = 30;

/** 食料が何日以内に尽きる見込みなら警告するか（SPEC-112 §7.4） */
export const FOOD_WARN_DAYS = 3;

/** 資源のアイコン（MCH の画像） */
const RES_ICON = {
  gum: 'Image/Icons/gum.png',
  food: 'Image/Icons/gold_dust.webp',
  mat: 'Image/Materials/Gemstones/315.webp',
  pop: 'Image/BattleIcons/Parameters/hp.png',
};

/**
 * ホームで新しく使う文言の既定値（data/messages.json に同じキーがあればそちらが勝つ）。
 * 行き先（Chat など）は副題に書かず、右端のチップに出す（SPEC-112 §7.5.1）。
 */
const HOME_TEXT = {
  'home.todo.foodOut': '食料が尽きました',
  'home.todo.foodSub2': '{name} が本拠地で農作する',
  'home.todo.foodSubAway2': '{name} を本拠地へ戻して農作する',
  'home.todo.heroSub2': '{status}・AP {ap}/{max}',
  'home.todo.soulSub2': '砦を落とした報酬です',
  'home.todo.extSub2': '届いたエクステンションをアリかナシかで',
  'home.foodOut': '不足',
  'home.go.chat': 'Chat で指示',
  'home.go.drive': 'Drive で選ぶ',
  'home.go.photo': 'Photo で選ぶ',
  'home.go.end': '1 日を進める',
  'home.endTurnShort': 'ターン終了',
  'home.noNoticesShort': 'まだありません',
  'navi.home.waitingMany': '{name}たち {n} 人が、まだ指示を待っています',
  'navi.home.waitingOne': 'あとは {name} だけです。指示を出したらターン終了へ',
  'navi.home.waitingNone': '全員の指示が済みました。いつでも 1 日を進められます',
  'navi.home.starveHit': '兵と人口が減ってしまいました。ここから立て直しましょう',
  'common.dangerZone': 'シーズンを終える',
  'common.giveupNote': '確認のあとで結果画面へ進みます',
};

const t = (app, key) => {
  const s = uiText(app.db, key);
  return s === key && HOME_TEXT[key] != null ? HOME_TEXT[key] : s;
};
/** {n} などを差し込んだ UI 文言 */
export function tf(app, key, vars = {}) {
  return t(app, key).replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? m : String(vars[k])));
}

const HAS_DOM = typeof document !== 'undefined';

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

/** バッテリーの段階（残りが少ないほど色が変わり、10% 以下で点滅） */
function batteryLevel(pct) {
  if (pct <= 10) return 'is-critical';
  if (pct <= 20) return 'is-low';
  if (pct <= 50) return 'is-mid';
  return 'is-high';
}

export function renderStatusBar(app, el) {
  clear(el);
  const st = app.state;
  if (!st) {
    el.appendChild(h('span', { class: 'status__left status__brand' }, 'MyCryptoWars'));
    el.appendChild(h('span', { class: 'status__clock num', 'aria-hidden': 'true' }));
    tickClock(el);
    return;
  }
  const day = Math.min(st.day, 28);
  const left = h('span', { class: 'status__left num' },
    `${t(app, 'status.day')} ${day}`, h('span', { class: 'status__sep', 'aria-hidden': 'true' }, '・'),
    t(app, `dow.${dayOfWeek(day)}`), h('span', { class: 'status__sep', 'aria-hidden': 'true' }, '・'),
    t(app, `season.${seasonOf(day)}`));
  const pct = battery(st.day);
  const bat = h('span', { class: ['status__battery', batteryLevel(pct)], 'aria-label': `${t(app, 'status.battery')} ${pct}%` },
    h('span', { class: 'num' }, `${pct}%`),
    h('span', { class: 'battery', 'aria-hidden': 'true' }, h('span', { class: 'battery__fill', style: { width: `${pct}%` } })));
  el.appendChild(left);
  // 真ん中に時計（D: 秒の点が脈打つ。画面がいつも生きている）
  el.appendChild(h('span', { class: 'status__clock num', 'aria-hidden': 'true' }));
  el.appendChild(bat);
  tickClock(el);
}

let clockTimer = null;
function tickClock(bar) {
  if (!HAS_DOM) return;
  const draw = () => {
    const c = bar.querySelector('.status__clock');
    if (!c) { clockTimer = null; return; }
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    if (c.dataset.time !== `${hh}${mm}`) {
      c.dataset.time = `${hh}${mm}`;
      clear(c);
      c.append(hh, h('span', { class: 'status__colon' }, ':'), mm);
    }
  };
  draw();
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = setInterval(draw, 5000);
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
// 指示のステータス（SPEC-112 §7.5.2。UI の表示だけ。state には保存しない）
//   app.ui.orderDone = { [squadId]: day }  … その日に「指示を終える」を押した
//   Chat / Map も同じものを使う（setOrderDone / orderStatus）
// ------------------------------------------------------------

function heroOf(app, squad) {
  return app.db.heroes[squad.heroId] || app.db.heroes[String(squad.heroId)] || null;
}

/** 「指示を終える」を記録する（on=false で取り消す） */
export function setOrderDone(app, squadId, on = true) {
  if (!app.ui.orderDone) app.ui.orderDone = {};
  if (on) app.ui.orderDone[squadId] = app.state ? app.state.day : 0;
  else delete app.ui.orderDone[squadId];
}

/**
 * 指示のステータス。'none'（未指示）/ 'doing'（指示中）/ 'done'（完了）/ 'off'（行動不可）
 * AP の上限と残りはエンジンの値（orders.apMax・squad.ap）から導く。
 */
export function orderStatus(app, squad) {
  const hero = heroOf(app, squad);
  const max = hero ? apMax(hero, squad, app.db) : 0;
  if (max <= 0) return 'off';
  const marked = app.ui.orderDone && app.state && app.ui.orderDone[squad.id] === app.state.day;
  if (marked || (squad.ap || 0) <= 0) return 'done';
  return (squad.orders || []).length ? 'doing' : 'none';
}

/** 自ランドの部隊（id 順） */
function mySquads(app) {
  const st = app.state;
  return Object.values(st.squads || {})
    .filter((s) => s.land === st.playerLand)
    .sort((a, b) => String(a.id).localeCompare(String(b.id), 'en', { numeric: true }));
}

// ------------------------------------------------------------
// 見込み（エンジンに聞いて並べるだけ）
// ------------------------------------------------------------

/**
 * 食料の見込み。1 日の増減 = economy.yields の food − economy.upkeep の food。
 * 減っていくなら、今の食料で何日もつか（その日のうちに 0 になる日まで）。
 * @returns {{net:number, days:number|null}}
 */
export function foodForecast(app) {
  const st = app.state;
  const me = st.lands[st.playerLand];
  const net = yields(st, app.db, st.playerLand).food - upkeep(st, app.db, st.playerLand).food;
  if (net >= 0) return { net, days: null };
  const food = Math.max(0, (me.res && me.res.food) || 0);
  return { net, days: Math.max(0, Math.ceil(food / -net)) };
}

/** 資源ごとの「前日からの増減」。直前の実行フェーズの yield があればそれ、無ければ 1 日の見込み */
function resDeltas(app) {
  const st = app.state;
  const ev = (app.ui.lastEvents || []).filter((e) => e.t === 'yield' && e.land === st.playerLand).pop();
  if (ev && ev.res) return { kind: 'actual', d: ev.res };
  const y = yields(st, app.db, st.playerLand);
  return { kind: 'forecast', d: { gum: y.gum, mat: y.mat, pop: y.pop, food: y.food - upkeep(st, app.db, st.playerLand).food } };
}

// ------------------------------------------------------------
// ナビゲーター（立ち絵の差分 + 吹き出し。ホーム・ランド選択・結果で使う）
// ------------------------------------------------------------

/** 立ち絵の差分（MCH の Image/Characters/navi_ain_*.png） */
export const NAVI_FACES = {
  normal: '11_idle',
  blink: '12_blink',
  talk: '14_talk',
  talk2: '07_talk',
  point: '00_pointer_up',
  happy: '02_both_arms_up',
  sparkle: '08_sparkle',
  smile: '06_smile',
  wink: '05_wink',
  wave: '03_wave',
  trouble: '01_arms_crossed',
  teary: '10_teary',
  cry: '09_cry',
  surprise: '04_hands_to_face',
};
/** 口を動かしてよい差分（ほかはポーズを崩さない） */
const TALKY = new Set(['normal', 'smile', 'point']);

export function naviPath(face) {
  return `Image/Characters/navi_ain_${NAVI_FACES[face] || NAVI_FACES.normal}.png`;
}

let preloaded = false;
function preloadNavi() {
  if (preloaded || !HAS_DOM || typeof Image === 'undefined') return;
  preloaded = true;
  for (const k of Object.keys(NAVI_FACES)) {
    const i = new Image();
    i.src = img(naviPath(k));
  }
}

/** 画面ごとに最後に話した文（同じ文の描き直しでは 1 文字ずつをやり直さない） */
const lastSaid = new Map();

/**
 * ナビゲーターの立ち絵と吹き出しを作る。
 * @param {object} app
 * @param {{face:string, text:string, ctx:string, cls?:string}} o ctx は画面の名前（同じ文を何度も打たないため）
 * @returns {{figure:HTMLElement, bubble:HTMLElement, start:Function}}
 *   start() を差したあとに呼ぶと、1 文字ずつ話し始める（口が動く・まばたき）
 */
export function navi(app, o) {
  preloadNavi();
  const face = NAVI_FACES[o.face] ? o.face : 'normal';
  const imgNode = imgEl(naviPath(face), t(app, 'navi.name'), { class: 'navi__img pixel', draggable: 'false' });
  const figure = h('div', { class: ['navi', `navi--${face}`, o.cls], dataset: { face } },
    h('span', { class: 'navi__shadow', 'aria-hidden': 'true' }), imgNode);
  const textEl = h('span', { class: 'navi-bubble__text' }, o.text);
  const bubble = h('p', { class: 'navi-bubble', 'aria-live': 'polite' },
    h('span', { class: 'navi-bubble__name' }, t(app, 'navi.name')), textEl);
  let poking = false;
  // 触ると、ウインクして跳ねる（A: 押したら必ず何かが返る）
  imgNode.addEventListener('click', () => {
    if (poking || !HAS_DOM) return;
    poking = true;
    figure.classList.remove('is-poke');
    void figure.offsetWidth;
    figure.classList.add('is-poke');
    imgNode.src = img(naviPath(face === 'wink' ? 'smile' : 'wink'));
    setTimeout(() => { poking = false; figure.classList.remove('is-poke'); if (figure.isConnected) imgNode.src = img(naviPath(face)); }, 900);
  });
  const start = () => {
    if (!HAS_DOM) return;
    const fresh = lastSaid.get(o.ctx) !== o.text;
    lastSaid.set(o.ctx, o.text);
    let talking = false;
    const setFace = (k) => {
      if (poking) return;
      const want = img(naviPath(k));
      if (imgNode.src !== want) imgNode.src = want;
    };
    if (fresh && !fx.reducedMotion()) {
      talking = true;
      figure.classList.add('is-enter');
      const ctl = fx.typeText(textEl, o.text, { cps: 34, delay: 260, skipOn: bubble });
      ctl.done.then(() => { talking = false; if (imgNode.isConnected) setFace(face); });
    }
    // 口の動き（話している間）とまばたき（待っている間）。要素が外れたら止まる
    let n = 0;
    const loop = () => {
      if (!figure.isConnected) return;
      n += 1;
      if (fx.reducedMotion()) { setFace(face); return; }
      if (talking && TALKY.has(face)) {
        setFace(n % 2 ? (face === 'normal' ? 'talk' : 'talk2') : face);
        setTimeout(loop, 130);
        return;
      }
      if (TALKY.has(face) && n % 3 === 0) {
        setFace('blink');
        setTimeout(() => { if (figure.isConnected) setFace(face); }, 120);
      }
      setTimeout(loop, talking ? 130 : 1400 + (n % 4) * 500);
    };
    setTimeout(loop, 300);
  };
  return { figure, bubble, start };
}

// ------------------------------------------------------------
// ホーム: 今日のやること（E: 次の一手をいつも 1 つ以上）
// ------------------------------------------------------------

/**
 * 「今日のやること」。優先度順に最大 3 件。
 * 選択待ち（SOUL / エクステンション）→ 食料が尽きる見込み → AP が残っているヒーロー → すべて済みなら ターン終了。
 */
export function todoList(app) {
  const st = app.state;
  const items = [];
  const pa = pendingApp();
  if (pa === 'drive') items.push({ kind: 'soul', icon: 'Image/Icons/emblem.webp', go: 'drive', title: t(app, 'home.todo.soul'), sub: t(app, 'home.todo.soulSub2'), act: () => go('drive') });
  if (pa === 'photo') items.push({ kind: 'ext', icon: 'Image/Icons/emblem.webp', go: 'photo', title: t(app, 'home.todo.ext'), sub: t(app, 'home.todo.extSub2'), act: () => go('photo') });

  const squads = mySquads(app);
  const ff = foodForecast(app);
  if (ff.days != null && ff.days <= FOOD_WARN_DAYS) {
    // 本拠地で農作できるヒーロー（orders.validate に聞く）。いなければ AP の多いヒーローを本拠地へ
    const farmOk = (s) => validate(st, app.db, s, { type: 'domestic', kind: 'farm' }).ok;
    const farmer = squads.find((s) => orderStatus(app, s) !== 'off' && farmOk(s));
    const alt = farmer || squads.filter((s) => orderStatus(app, s) !== 'off' && (s.ap || 0) > 0).sort((a, b) => (b.ap || 0) - (a.ap || 0))[0];
    const who = alt ? heroOf(app, alt) : null;
    items.push({
      kind: 'food', icon: RES_ICON.food, danger: true, go: who ? 'chat' : null,
      // 動けるヒーローがいなければ、いま打てる手ではない（「次の一手」にしない。並びの最後へ）
      passive: !who,
      // 下の主役ボタンの文言（何をするか。状況ではなく動作で書く）
      cta: who ? tf(app, 'home.todo.hero', { name: who.name }) : null,
      // 0 日 = もう尽きている（「あと 0 日」とは書かない）
      title: ff.days <= 0 ? t(app, 'home.todo.foodOut') : tf(app, 'home.todo.food', { n: ff.days }),
      sub: who ? tf(app, farmer ? 'home.todo.foodSub2' : 'home.todo.foodSubAway2', { name: who.name }) : t(app, 'home.todo.foodSubNone'),
      act: () => {
        if (!alt) { go('chat'); return; }
        // 農作できるなら、Chat の内政のメニューを開いた状態で（Chat の画面状態があるときだけ）
        if (farmer && app.ui.chat) app.ui.chat.menu = 'domestic';
        go('chat', { squad: alt.id });
      },
    });
  }

  const waiting = waitingSquads(app);
  if (waiting.length) {
    const s = waiting[0];
    const hero = heroOf(app, s);
    const max = hero ? apMax(hero, s, app.db) : 0;
    const status = orderStatus(app, s);
    items.push({
      kind: 'hero', hero, status, ap: s.ap || 0, max, go: 'chat',
      title: tf(app, 'home.todo.hero', { name: hero ? hero.name : s.id }),
      sub: tf(app, 'home.todo.heroSub2', { status: t(app, `home.status.${status}`), ap: s.ap || 0, max })
        + (waiting.length > 1 ? `・${tf(app, 'home.todo.heroMore', { n: waiting.length - 1 })}` : ''),
      act: () => go('chat', { squad: s.id }),
    });
  } else if (!pa) {
    items.push({ kind: 'end', go: 'end', title: t(app, 'home.todo.end'), sub: t(app, 'home.todo.endSub'), act: () => endTurn() });
  }
  // 打てる手を先に（打てない警告は残すが、「次の一手」にはしない）
  items.sort((a, b) => (a.passive ? 1 : 0) - (b.passive ? 1 : 0));
  return items.slice(0, 3);
}

/** まだ指示が要るヒーローの部隊（未指示を先に。同じなら AP が多い順） */
function waitingSquads(app) {
  const rank = (s) => (orderStatus(app, s) === 'none' ? 0 : 1);
  return mySquads(app)
    .filter((s) => { const k = orderStatus(app, s); return k === 'none' || k === 'doing'; })
    .sort((a, b) => rank(a) - rank(b) || (b.ap || 0) - (a.ap || 0));
}

/** ナビゲーターのひとことと差分（状況で変える） */
/**
 * ナビゲーターのひとことと差分（状況で変える）。
 * やることカードと同じ文は言わない（SPEC-112 §2 E）。警告はカードとバッジに任せ、吹き出しは
 * 「いまの状況」— 誰が何人待っているか・昨日何が起きたか — を一言で。食料の危うさは表情（差分）で見せる。
 */
function homeLine(app, todo, ff) {
  const st = app.state;
  const me = st.playerLand;
  const evs = app.ui.lastEvents || [];
  const land = landDef(app, me);
  const landName = land ? land.nameJa || land.name : me;
  const pct = battery(st.day);
  const mine = (id) => st.squads[id] && st.squads[id].land === me;
  const first = todo[0];
  const waiting = waitingSquads(app);
  const lead = waiting[0] ? heroOf(app, waiting[0]) : null;
  const summary = () => (waiting.length >= 2
    ? tf(app, 'navi.home.waitingMany', { name: lead ? lead.name : '', n: waiting.length })
    : waiting.length === 1 ? tf(app, 'navi.home.waitingOne', { name: lead ? lead.name : '' })
      : t(app, 'navi.home.waitingNone'));
  const hungry = ff.days != null && ff.days <= FOOD_WARN_DAYS;
  if (evs.some((e) => e.t === 'starve' && e.land === me)) return { face: 'cry', text: t(app, 'navi.home.starveHit') };
  if (evs.some((e) => e.t === 'battle' && e.target === 'home' && e.defender === me)) return { face: 'surprise', text: t(app, 'navi.home.homeHit') };
  if (first && first.kind === 'soul') return { face: 'sparkle', text: t(app, 'navi.home.fortWin') };
  if (evs.some((e) => e.t === 'fort_fallen' && e.by === me)) return { face: 'happy', text: t(app, 'navi.home.fortWin') };
  if (evs.some((e) => e.t === 'routed' && mine(e.squad))) return { face: 'teary', text: t(app, 'navi.home.routed') };
  if (st.day === 1 && first && first.kind === 'hero' && first.status === 'none' && !hungry) return { face: 'wave', text: tf(app, 'navi.home.welcome', { land: landName }) };
  if (hungry) return { face: ff.days <= 1 ? 'teary' : 'trouble', text: summary() };
  if (pct <= 20) return { face: 'surprise', text: tf(app, 'navi.home.lowBattery', { n: pct }) };
  if (first && first.kind === 'ext') return { face: 'sparkle', text: summary() };
  if (first && first.kind === 'hero') return { face: 'point', text: summary() };
  if (first && first.kind === 'end') return { face: 'smile', text: t(app, 'navi.home.allDone') };
  return { face: 'normal', text: t(app, 'navi.home.idle') };
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
  return h('button', { class: ['app-icon', `app-icon--${name}`], type: 'button', dataset: { app: name }, onClick: () => go(name) },
    h('span', { class: 'app-icon__tile', 'aria-hidden': 'true' },
      h('span', { class: 'app-icon__glyph' }, h('span', { class: `app-icon__shape app-icon__shape--${name}` }))),
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

const SIGN_MINUS = '−';
function signed(n) {
  const v = Math.round(n);
  return v > 0 ? `+${v}` : v < 0 ? `${SIGN_MINUS}${-v}` : '±0';
}

function resRow(app, land, ff) {
  const keys = ['gum', 'food', 'mat', 'pop'];
  const dd = resDeltas(app);
  return h('dl', { class: 'res-row' }, keys.map((k) => {
    const v = Math.floor((land.res && land.res[k]) || 0);
    const d = dd.d[k] || 0;
    const warn = k === 'food' && ff.days != null && ff.days <= FOOD_WARN_DAYS;
    return h('div', { class: ['res', `res--${k}`, warn ? 'is-danger' : null], dataset: { res: k } },
      h('dt', null, imgEl(RES_ICON[k], '', { class: 'res__icon', 'aria-hidden': 'true' }), h('span', { class: 'res__name' }, t(app, `res.${k}`))),
      h('dd', null,
        h('span', { class: 'res__val num', dataset: { to: v } }, String(v)),
        h('span', {
          class: ['res__delta', 'num', d > 0 ? 'is-up' : d < 0 ? 'is-down' : null, dd.kind === 'forecast' ? 'is-forecast' : null],
          title: t(app, dd.kind === 'forecast' ? 'home.forecast' : 'home.delta'),
          'aria-label': `${t(app, dd.kind === 'forecast' ? 'home.forecast' : 'home.delta')} ${signed(d)}`,
        }, signed(d))),
      warn ? h('span', { class: 'res__warn num' }, ff.days <= 0 ? t(app, 'home.foodOut') : tf(app, 'home.foodWarn', { n: ff.days })) : null);
  }));
}

const KIND_FACE = { soul: 'is-gold', ext: 'is-gold', food: 'is-bad', hero: 'is-info', end: 'is-ok' };

function todoCard(app, it, i) {
  const art = it.kind === 'hero' && it.hero
    ? heroImg(it.hero, { class: 'todo__hero' })
    : it.icon ? imgEl(it.icon, '', { class: 'todo__icon', 'aria-hidden': 'true' })
      : h('span', { class: 'todo__mark', 'aria-hidden': 'true' });
  const ap = it.kind === 'hero' && it.max > 0
    ? h('span', { class: 'todo__ap', 'aria-hidden': 'true', style: { '--ap': `${Math.round((it.ap / it.max) * 100)}%` } })
    : null;
  return h('li', { class: 'todo__item' },
    h('button', {
      class: ['todo', 'panel', `todo--${it.kind}`, KIND_FACE[it.kind], i === 0 ? 'is-next' : null], type: 'button',
      dataset: { todo: it.kind }, onClick: () => it.act(),
    },
    h('span', { class: 'todo__art' }, art, ap),
    h('span', { class: 'todo__body' },
      i === 0 ? h('span', { class: 'todo__tag' }, t(app, 'home.next')) : null,
      h('span', { class: 'todo__title' }, it.title),
      h('span', { class: 'todo__sub' }, it.sub)),
    // 行き先は副題に書かず、右端のチップに（どこで何をするかが一目で分かる）
    it.go ? h('span', { class: 'todo__chip' }, t(app, `home.go.${it.go}`), h('span', { class: 'todo__go', 'aria-hidden': 'true' }))
      : h('span', { class: 'todo__go', 'aria-hidden': 'true' })));
}

/**
 * 下の操作帯（SPEC-112 §7.5.1: 主役は 1 画面に 1 つ）。
 * - まだやることがある: 主役の金 = 「次の一手」と同じ文言と行き先。ターン終了は枠だけの副ボタン（あと N 人 未指示）
 * - 全員済んだ: ターン終了だけが金で、脈打つ（.is-ready）
 * ギブアップはここに置かない（誤タップの危険）。設定の最下段へ。
 */
function actionBar(app, todo, left, allDone) {
  const next = todo[0];
  if (allDone || !next) {
    return h('div', { class: 'home__actions is-done' },
      h('button', { class: ['btn-primary', 'home__end', allDone ? 'is-ready' : null], type: 'button', dataset: { ripple: 'accent' }, onClick: () => endTurn() },
        h('span', { class: 'home__end-main' }, t(app, 'home.endTurn')),
        h('span', { class: 'home__end-sub' }, t(app, 'home.go.end'))));
  }
  const label = next.cta || next.title;
  return h('div', { class: 'home__actions' },
    h('button', { class: ['btn-secondary', 'home__end', 'is-sub'], type: 'button', onClick: () => endTurn() },
      h('span', { class: 'home__end-main' }, t(app, 'home.endTurnShort')),
      left > 0 ? h('span', { class: 'home__end-sub num' }, tf(app, 'home.endLeft', { n: left })) : null),
    h('button', { class: ['btn-primary', 'home__next', `home__next--${next.kind}`, Array.from(label).length > 16 ? 'is-long' : null], type: 'button', dataset: { ripple: 'accent', next: next.kind }, onClick: () => next.act() },
      h('span', { class: 'home__next-tag' }, t(app, 'home.next')),
      h('span', { class: 'home__next-main' }, label)));
}

/** ホームに入ってきたとき（最初の描画・別の画面から）だけ、順に出す */
let homeEntered = false;

export const homeView = {
  render(app) {
    const st = app.state;
    const me = st.lands[st.playerLand];
    const def = landDef(app, st.playerLand) || { id: st.playerLand, nameJa: st.playerLand, color: '#c4a35a' };
    const notices = (st.notices || []).slice(-NOTICE_LIST_MAX).reverse();
    const ff = foodForecast(app);
    const todo = todoList(app);
    const line = homeLine(app, todo, ff);
    const nv = navi(app, { face: line.face, text: line.text, ctx: `home:${st.day}`, cls: 'home__navi' });
    const left = mySquads(app).filter((s) => orderStatus(app, s) === 'none').length;
    const allDone = todo.some((x) => x.kind === 'end');

    const root = h('section', { class: 'home', style: { '--land': def.color } },
      // 壁紙（一番奥。自ランドのクリプタイドをぼかして漂わせる）
      h('div', { class: 'home__wall', 'aria-hidden': 'true' },
        imgEl(landAssetPath(def.cryptid), '', { class: 'home__wall-img pixel' })),
      h('header', { class: 'home__land' },
        h('span', { class: 'home__emblem' }, imgEl(landAssetPath(def.icon), def.nameJa || def.name, { class: 'home__land-icon' })),
        h('div', { class: 'home__land-text' },
          h('span', { class: 'home__land-name' }, def.nameJa || def.name),
          h('span', { class: 'home__land-sub num' },
            h('span', { class: 'muted' }, t(app, 'drive.fortPoints')), ' ',
            h('strong', { class: 'home__fp', dataset: { to: me.fortPoints || 0 } }, String(me.fortPoints || 0)))),
        h('button', { class: 'btn-ghost home__settings', type: 'button', 'aria-label': t(app, 'common.settings') },
          h('span', { class: 'home__gear', 'aria-hidden': 'true' }), h('span', { class: 'home__settings-text' }, t(app, 'common.settings')))),
      resRow(app, me, ff),
      h('div', { class: 'home__stage' },
        h('div', { class: 'home__bubble-wrap' }, nv.bubble),
        h('div', { class: 'home__navi-clip' }, nv.figure)),
      h('section', { class: 'home__todo panel panel--glass', 'aria-labelledby': 'home-todo-title' },
        h('h2', { class: 'section-title home__todo-title', id: 'home-todo-title' },
          t(app, 'home.todo'), h('span', { class: 'home__todo-day num' }, tf(app, 'home.todoCount', { n: todo.length }))),
        h('ol', { class: 'todo-list' }, todo.map((it, i) => todoCard(app, it, i)))),
      h('nav', { class: 'home__apps panel panel--glass', 'aria-label': t(app, 'home.apps') }, APPS.map((a) => appIcon(app, a))),
      // 通知。空なら 1 行に畳む（空の箱で場所を取らない）
      notices.length
        ? h('section', { class: 'home__notices', 'aria-labelledby': 'home-notices-title' },
          h('h2', { class: 'section-title home__notices-title', id: 'home-notices-title' }, t(app, 'home.notices'),
            h('span', { class: 'home__notices-count num' }, String(notices.length))),
          h('ul', { class: 'notice-list' }, notices.map((n) => noticeItem(app, n))))
        : h('section', { class: 'home__notices is-empty', 'aria-labelledby': 'home-notices-title' },
          h('h2', { class: 'section-title home__notices-title', id: 'home-notices-title' }, t(app, 'home.notices')),
          h('p', { class: 'home__notices-empty muted' }, t(app, 'home.noNotices'))),
      // 親指の帯。主役は 1 つだけ: 未指示がいるあいだは「次の一手」、全員済んだら「ターン終了」（金・脈打つ）
      actionBar(app, todo, left, allDone));
    root.querySelector('.home__settings').addEventListener('click', () => openSettings(app));
    root._navi = nv;
    return root;
  },

  mount(app, el) {
    if (!el) return;
    // 数字を前回の値から転がす（増えたら緑・減ったら赤）
    for (const v of el.querySelectorAll('.res__val')) {
      const k = v.closest('.res').dataset.res;
      fx.rollNumber(v, Number(v.dataset.to), { key: `home.res.${k}`, format: (n) => Math.floor(n).toLocaleString('ja-JP') });
    }
    const fp = el.querySelector('.home__fp');
    if (fp) fx.rollNumber(fp, Number(fp.dataset.to), { key: 'home.fp' });
    if (el._navi) el._navi.start();
    watchToasts(el);
    // 入ってきたときだけ順に出す（設定を閉じたなどの描き直しでは出さない）
    const entering = !homeEntered || !!document.querySelector('.phone__ghost');
    homeEntered = true;
    if (entering) {
      fx.stagger(el.querySelectorAll('.res'), { step: 40, delay: 60, from: 'down', distance: 8 });
      fx.stagger(el.querySelectorAll('.todo__item'), { step: 70, delay: 140, from: 'left', distance: 18 });
      fx.stagger(el.querySelectorAll('.app-icon'), { step: 35, delay: 220, from: 'scale' });
      fx.stagger(el.querySelectorAll('.notice-list > .notice.is-new'), { step: 50, delay: 320 });
    }
  },
};

// ------------------------------------------------------------
// ホームのトースト（SPEC-112 §2）
//   ホームでは、トーストはステータスバーの下の 1 行帯に出る（css: .phone[data-app="home"] > .toast-stack）。
//   少し読ませてから、通知の欄へ吸い込まれる（600ms）。同じ知らせが帯と通知の欄に 2 重に残らない。
//   fx.toast（基盤）は変えない。ここは出てきたトーストを見張って動かすだけ。
// ------------------------------------------------------------

/** 帯に出してから吸い込みを始めるまで（ms） */
const TOAST_HOLD = 1500;
/** 吸い込みの長さ（ms） */
const TOAST_ABSORB = 600;

let toastWatch = null;

function absorbToast(phone, toastEl) {
  if (!toastEl || toastEl._absorb || toastEl.classList.contains('is-leaving')) return;
  toastEl._absorb = setTimeout(() => {
    if (!toastEl.isConnected || phone.dataset.app !== 'home' || toastEl.classList.contains('is-leaving')) return;
    const box = phone.querySelector('.home__notices');
    if (!box || fx.reducedMotion() || !toastEl.animate) return; // 通知の欄が無い・動きを減らす → 帯のまま時間で消える
    clearTimeout(toastEl._timer); // fx の「時間で消す」を止めて、こちらで消す
    const from = toastEl.getBoundingClientRect();
    const to = (box.querySelector('.home__notices-title') || box).getBoundingClientRect();
    const dx = (to.left + Math.min(to.width, 120) / 2) - (from.left + from.width / 2);
    const dy = (to.top + to.height / 2) - (from.top + from.height / 2);
    toastEl.classList.add('is-absorbing');
    const a = toastEl.animate([
      { transform: 'none', opacity: 1, filter: 'none' },
      { transform: 'translateY(2px) scale(1.02, .9)', opacity: 1, offset: 0.12 },
      { transform: `translate(${dx * 0.5}px, ${dy * 0.55}px) scale(.62, .6)`, opacity: 0.95, offset: 0.55 },
      { transform: `translate(${dx}px, ${dy}px) scale(.22, .34)`, opacity: 0, filter: 'blur(1.5px)' },
    ], { duration: TOAST_ABSORB, easing: 'cubic-bezier(.45, 0, .35, 1)', fill: 'forwards' });
    const done = () => {
      toastEl.remove();
      if (!box.isConnected) return;
      box.classList.remove('is-absorb');
      void box.offsetWidth;
      box.classList.add('is-absorb');
      setTimeout(() => box.classList.remove('is-absorb'), 700);
    };
    a.finished.then(done, done);
  }, TOAST_HOLD);
}

function watchToasts(el) {
  if (!HAS_DOM || typeof MutationObserver === 'undefined') return;
  const phone = el.closest('.phone');
  if (!phone) return;
  const scan = () => {
    if (phone.dataset.app !== 'home') return;
    const stack = phone.querySelector(':scope > .toast-stack');
    if (!stack) return;
    if (!toastWatch || toastWatch.stack !== stack) {
      if (toastWatch && toastWatch.stackObs) toastWatch.stackObs.disconnect();
      const stackObs = new MutationObserver(scan);
      stackObs.observe(stack, { childList: true });
      toastWatch = { ...(toastWatch || {}), stack, stackObs };
    }
    for (const n of stack.children) absorbToast(phone, n);
  };
  if (!toastWatch || toastWatch.phone !== phone) {
    if (toastWatch && toastWatch.phoneObs) toastWatch.phoneObs.disconnect();
    // トーストの入れ物は最初のトーストで作られるので、端末の直下を見張る
    const phoneObs = new MutationObserver(scan);
    phoneObs.observe(phone, { childList: true });
    toastWatch = { phone, phoneObs };
  }
  scan();
}

// ------------------------------------------------------------
// 設定（音・動きを減らす）
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
    // 動きを減らす（SPEC-112 §1。常時の背景・画面の切り替え・めくりを止める / 短くする）
    const calm = fx.getReduceMotionSetting();
    body.appendChild(h('div', { class: 'setting-row' },
      h('span', { id: 'setting-motion' }, t(app, 'common.reduceMotion')),
      h('button', {
        class: ['switch', calm ? 'is-on' : null], type: 'button', role: 'switch', 'aria-checked': calm ? 'true' : 'false', 'aria-labelledby': 'setting-motion',
        onClick: () => { fx.setReduceMotion(!calm); draw(); },
      }, h('span', { class: 'switch__knob', 'aria-hidden': 'true' }), h('span', { class: 'switch__text' }, calm ? t(app, 'common.on') : t(app, 'common.off')))));
    body.appendChild(h('div', { class: 'btn-row' },
      h('button', { class: 'btn-secondary', type: 'button', onClick: () => closePopup() }, t(app, 'common.close'))));
    // ギブアップは最下段に。赤い文字・線で区切り、押すと確認（main.giveUp）が出る。親指の帯には置かない
    if (app.state && !app.state.ended && !app.ui.executing) {
      body.appendChild(h('div', { class: 'settings__danger' },
        h('p', { class: 'settings__danger-label' }, t(app, 'common.dangerZone')),
        h('button', { class: 'settings__giveup', type: 'button', onClick: () => giveUp() },
          h('span', { class: 'settings__giveup-main' }, t(app, 'common.giveup')),
          h('span', { class: 'settings__giveup-note' }, t(app, 'common.giveupNote')))));
    }
  };
  draw();
  openPopup(body, { title: t(app, 'common.settings') });
}
