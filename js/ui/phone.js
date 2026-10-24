// phone.js — スマホの外枠・ステータスバー・ホーム・通知・下のホームボタン（SPEC-111 §2・SPEC-112 §2）
//
// 数値・判定はエンジンに聞く（season.battery / dayOfWeek / seasonOf、economy.yields / upkeep、orders.apMax / validate）。
// ここは描くだけ。食料の見込みは「1 日の産出 − 1 日の消費」をエンジンに聞いて並べるだけで、新しいルールは書かない。
//
// SPEC-114 §2・§6・§7: 朝の報告（週報を先頭に）・資源のウィジェット（残高｜±N/日・あと N 日）・兵と士気・状況の 1 行・
// 今日のやること（効き目つき）・主役ボタンの要約と「食料が今夜尽きます」。数字は ledger-view.js の outlook（エンジンの
// breakdown / forecast / previewDomestic の値）から取る。内訳シートは ledger-view.js。
//
// ホームの層（SPEC-112 §2 B）: 奥に壁紙（自ランドのクリプタイド。ぼかして漂う）→ 吹き出し → ナビゲーターの立ち絵
// （吹き出しの端に重なる）→ 「今日のやること」の板（立ち絵の足元を隠す）。

import { h, clear, imgEl, landAssetPath, heroImg } from './h.js';
import { uiText } from '../engine/lines.js';
import { battery, dayOfWeek, seasonOf } from '../engine/season.js';
import { forecast, previewDomestic, previewRation, buildCost, totalTroops } from '../engine/economy.js';
import { moraleOf, rationOf, MORALE_SHAKEN, MORALE_DELTA } from '../engine/morale.js';
import { distance } from '../engine/hex.js';
import { noticesFrom } from '../engine/turn.js';
import { apMax, validate } from '../engine/orders.js';
import { go, endTurn, giveUp, openPopup, closePopup, getApp, pendingApp, skipExecute } from '../main.js';
import { save } from '../state.js';
import { isSoundOn, setSound, playBgm } from './audio.js';
import { img } from '../constants.js';
import * as fx from './fx.js';
import { openLedger, outlook, plannedWith, rationOutlook, daysChip, moraleGauge, signed, fmt, L } from './ledger-view.js';

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
  'navi.home.starveHit': '食料が尽きて、部隊の士気が下がりました。ここから立て直しましょう',
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
// 朝の報告の控え（main.js が実行フェーズの直前に呼ぶ）
// ------------------------------------------------------------

/**
 * 実行フェーズの直前の自ランドの様子（朝の報告で「きのうとの差」を出すため。main.js の endTurn が呼ぶ）。
 * 数はエンジンの forecast とランドの資源をそのまま写すだけ。
 */
export function morningSnapshot(app) {
  const st = app.state;
  const me = st.playerLand;
  const fc = forecast(st, app.db, me);
  const squads = {};
  // 全ランドの部隊の兵（戦闘で減った量を、イベントの順にたどって数えるため。自ランドは士気も）
  const all = {};
  for (const s of Object.values(st.squads)) {
    all[s.id] = { troops: Math.max(0, s.troops || 0), land: s.land };
    if (s.land === me) squads[s.id] = { troops: s.troops || 0, morale: moraleOf(s) };
  }
  return { day: st.day, res: { ...st.lands[me].res }, troops: fc.troops.total, moraleAvg: fc.morale.avg, squads, all };
}

/**
 * 食料の見込み（互換のため残す。SPEC-114 から breakdown の値）。
 * @returns {{net:number, days:number|null}} days は 1 が「今夜尽きる」（breakdown の daysLeft）
 */
export function foodForecast(app) {
  const f = forecast(app.state, app.db, app.state.playerLand).food;
  return { net: f.net, days: f.daysLeft };
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

/** 「あと N 日」を文に（1 = 今夜） */
function daysWord(app, d) {
  if (d == null) return L(app, 'home.t3.enough');
  return d <= 1 ? L(app, 'home.t3.tonight') : L(app, 'home.t3.days', { n: d });
}

/** 今日のやることに並べる数（朝の報告と並んでも、アプリの列が下の帯に潜らないように） */
export const TODO_MAX = 2;

/**
 * 農作の効き目（SPEC-114 §2.4・§0 原則 11）。罰を避ける最小の回数を先に、AP いっぱいの回数をあとに。
 * 今夜尽きるなら「今夜を越せる」最小の回数、そうでなければ「警告の外（あと 4 日より先）」に出る最小の回数。
 * 見込みは economy.domestic を写しに当てて forecast に聞く（plannedWith）。
 * @returns {{min:number|null, minAfter, max:number, maxAfter, now}}
 */
export function farmPlan(app, ol, farmer) {
  const st = app.state;
  const me = st.playerLand;
  const p = previewDomestic(st, app.db, farmer, 'farm');
  const max = Math.max(1, p.repeat);
  const now = ol.plan.food.daysLeft;
  const out = { min: null, minAfter: null, max, maxAfter: now, now };
  for (let n = 1; n <= max; n++) {
    const after = forecast(plannedWith(app, farmer.id, 'farm', n), app.db, me).food.daysLeft;
    if (n === max) out.maxAfter = after;
    const ok = ol.tonight ? after !== 1 : after == null || after > FOOD_WARN_DAYS;
    if (ok && out.min == null) { out.min = n; out.minAfter = after; }
  }
  return out;
}

/** 今夜足りない食料（積んだ指示のあと。足りるなら 0） */
export function foodShortTonight(ol) {
  return ol.tonight ? Math.max(0, -(ol.foodStock + ol.plan.food.net)) : 0;
}

/**
 * 「今日のやること」。優先度順に最大 TODO_MAX 件（SPEC-112 §2・SPEC-114 §2.4）。
 * 選択待ち（SOUL / エクステンション）→ 食料が尽きる見込み（罰を避ける最小の農作の回数。農作で足りなければ配給「節約」。
 * ただし節約で「あと何日」も今夜の飢えも変わらないなら勧めない）→ 今夜逃げる・動揺している部隊（恩賞・休息。
 * 本拠地の外なら 移動 → 恩賞 の手順）→ AP が残っているヒーロー → すべて済みなら ターン終了。
 * 打てる手の無い知らせ（今夜 人口を兵の回復に使い切る など）は最後。
 * 見込みは積んだ指示のあと（ledger-view.outlook の plan）で見る。農作を積めば食料のカードは消える。
 */
export function todoList(app, ol = outlook(app)) {
  const st = app.state;
  const me = st.playerLand;
  const land = st.lands[me];
  const items = [];
  const pa = pendingApp();
  if (pa === 'drive') items.push({ kind: 'soul', icon: 'Image/Icons/emblem.webp', go: 'drive', title: t(app, 'home.todo.soul'), sub: t(app, 'home.todo.soulSub2'), act: () => go('drive') });
  if (pa === 'photo') items.push({ kind: 'ext', icon: 'Image/Icons/emblem.webp', go: 'photo', title: t(app, 'home.todo.ext'), sub: t(app, 'home.todo.extSub2'), act: () => go('photo') });

  const squads = mySquads(app);
  const pf = ol.plan.food;
  if (pf.daysLeft != null && pf.daysLeft <= FOOD_WARN_DAYS && daysChip(app, pf.daysLeft)) {
    // 本拠地で農作できるヒーロー（orders.validate に聞く）。いなければ AP の多いヒーローを本拠地へ
    const farmOk = (s) => validate(st, app.db, s, { type: 'domestic', kind: 'farm' }).ok;
    const farmer = squads.find((s) => orderStatus(app, s) !== 'off' && farmOk(s));
    const alt = farmer || squads.filter((s) => orderStatus(app, s) !== 'off' && (s.ap || 0) > 0).sort((a, b) => (b.ap || 0) - (a.ap || 0))[0];
    const who = alt ? heroOf(app, alt) : null;
    const short = foodShortTonight(ol);
    let fixes = false;
    let sub = who ? tf(app, 'home.todo.foodSubAway2', { name: who.name }) : t(app, 'home.todo.foodSubNone');
    if (farmer) {
      const fp = farmPlan(app, ol, farmer);
      fixes = fp.min != null;
      if (fixes) {
        // 1 行目: 罰を避ける最小の回数（今夜なら不足の量つき）。2 行目: AP いっぱいなら
        const first = L(app, 'homeF.todo.farmMin', { n: fp.min, to: daysWord(app, fp.minAfter) })
          + (short > 0 ? L(app, 'homeF.todo.short', { n: fmt(short) }) : '');
        sub = fp.max > fp.min && fp.maxAfter !== fp.minAfter
          ? [first, h('br'), L(app, 'homeF.todo.farmMax', { n: fp.max, to: daysWord(app, fp.maxAfter) })]
          : first;
      } else {
        sub = L(app, 'homeF.todo.farmWeak', { n: fp.max, to: daysWord(app, fp.maxAfter) });
      }
    }
    const food = {
      kind: 'food', icon: RES_ICON.food, danger: true, go: who ? 'chat' : null,
      // 動けるヒーローがいなければ、いま打てる手ではない（「次の一手」にしない。並びの最後へ）
      passive: !who,
      cta: who ? tf(app, 'home.todo.hero', { name: who.name }) : null,
      ctaName: who ? who.name : null,
      title: ol.foodStock <= 0 ? t(app, 'home.todo.foodOut') : pf.daysLeft <= 1 ? L(app, 'home.t3.foodTonight') : tf(app, 'home.todo.food', { n: pf.daysLeft }),
      sub,
      act: () => {
        if (!alt) { go('chat'); return; }
        // 農作できるなら、Chat の内政のメニューを開いた状態で（Chat の画面状態があるときだけ）
        if (farmer && app.ui.chat) app.ui.chat.menu = 'domestic';
        go('chat', { squad: alt.id });
      },
    };
    // 農作だけでは足りない（または農作できない）なら、配給「節約」。効かない（あと何日も今夜の飢えも変わらない）なら勧めない
    const ration = rationOf(land);
    if (!fixes && ration !== 'save') {
      const now = rationOutlook(app, ration, ol.sim);
      const then = rationOutlook(app, 'save', ol.sim);
      const pr = previewRation(ol.sim, app.db, me, 'save');
      const helps = then.daysLeft !== now.daysLeft;
      if (helps) {
        items.push({
          kind: 'ration', icon: RES_ICON.food, go: 'ledger',
          cta: L(app, 'home.t3.rationCta'),
          title: L(app, 'home.t3.ration'),
          sub: [L(app, 'homeF.todo.rationDays', { from: daysWord(app, now.daysLeft), to: daysWord(app, then.daysLeft) }), h('br'), L(app, 'home.t3.rationMorale', { m: signed(pr.moralePerDay) })],
          act: () => openLedger(app, 'food'),
        });
      }
    }
    items.push(food);
  }

  // 今夜逃げる部隊・動揺している部隊（積んだ指示のあとの夜。ol.night = planNight）
  const desert = new Map(ol.night.desert.map((d) => [d.squad, d.amount]));
  const low = squads
    .filter((s) => s.status !== 'routed' && (s.troops || 0) > 0 && (desert.has(s.id) || moraleOf(ol.sim.squads[s.id] || s) < MORALE_SHAKEN))
    .sort((a, b) => (desert.get(b.id) || 0) - (desert.get(a.id) || 0) || moraleOf(ol.sim.squads[a.id] || a) - moraleOf(ol.sim.squads[b.id] || b))[0];
  if (low) {
    const hero = heroOf(app, low);
    const name = hero ? hero.name : low.id;
    const total = ol.desert.total;
    const pr = previewDomestic(st, app.db, low, 'reward');
    const atHome = land && low.tile === land.home;
    const reward = { v: signed(pr.delta.morale || MORALE_DELTA.reward), cost: fmt(-pr.delta.gum) };
    let how;
    if (pr.ok) how = L(app, 'homeF.todo.reward', reward);
    else if (pr.reason === 'home' && land && land.home != null) how = L(app, 'homeF.todo.moveReward', { d: distance(low.tile, land.home, st.map.w, st.map.h), ...reward });
    else if (atHome && (low.ap || 0) > 0) how = L(app, 'home.t3.restSub', { v: signed(MORALE_DELTA.rest) });
    else how = L(app, 'homeF.todo.noAp');
    items.push({
      kind: 'morale', hero, danger: total > 0, go: 'chat', squad: low.id,
      cta: tf(app, 'home.todo.hero', { name }),
      ctaName: name,
      title: total > 0
        ? (ol.desert.squads > 1 ? L(app, 'homeF.todo.desertN', { n: fmt(total), k: ol.desert.squads }) : L(app, 'home.t3.desert', { n: fmt(total) }))
        : L(app, 'home.t3.shaken', { m: moraleOf(low) }),
      sub: [L(app, 'homeF.todo.who', { name, m: moraleOf(ol.sim.squads[low.id] || low) }), h('br'), how],
      act: () => {
        if (pr.ok && app.ui.chat) app.ui.chat.menu = 'domestic';
        go('chat', { squad: low.id });
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
      kind: 'hero', hero, status, ap: s.ap || 0, max, go: 'chat', ctaName: hero ? hero.name : s.id,
      title: tf(app, 'home.todo.hero', { name: hero ? hero.name : s.id }),
      sub: tf(app, 'home.todo.heroSub2', { status: t(app, `home.status.${status}`), ap: s.ap || 0, max })
        + (waiting.length > 1 ? `・${tf(app, 'home.todo.heroMore', { n: waiting.length - 1 })}` : ''),
      act: () => go('chat', { squad: s.id }),
    });
  } else if (!pa) {
    items.push({ kind: 'end', go: 'end', title: t(app, 'home.todo.end'), sub: t(app, 'home.todo.endSub'), act: () => tryEndTurn(app) });
  }

  // 今夜 人口を兵の回復に使い切る（徴兵できなくなる）。打てる手ではないので最後（前もって知らせる）
  const pb = ol.base.pop;
  const recover = pb.expense.filter((r) => r.key === 'recover').reduce((a, r) => a + r.value, 0);
  if (recover > 0 && pb.stock > 0 && pb.stock + pb.net <= 0) {
    items.push({
      kind: 'pop', icon: RES_ICON.pop, passive: true, go: 'ledger',
      title: L(app, 'homeF.todo.popOut'),
      // 2 行: 何に使うか / そのあと何ができなくなるか
      sub: L(app, 'homeF.todo.popOutSub', { n: fmt(pb.stock) }).split('。').filter(Boolean),
      act: () => openLedger(app, 'pop'),
    });
  }
  // 打てる手を先に（打てない警告は残すが、「次の一手」にはしない）
  items.sort((a, b) => (a.passive ? 1 : 0) - (b.passive ? 1 : 0));
  return items.slice(0, TODO_MAX);
}

/** まだ指示が要るヒーローの部隊（未指示を先に。同じなら AP が多い順） */
function waitingSquads(app) {
  const rank = (s) => (orderStatus(app, s) === 'none' ? 0 : 1);
  return mySquads(app)
    .filter((s) => { const k = orderStatus(app, s); return k === 'none' || k === 'doing'; })
    .sort((a, b) => rank(a) - rank(b) || (b.ap || 0) - (a.ap || 0));
}

/**
 * ナビゲーターのひとことと差分（状況で変える）。
 * 危機の日は、朝の報告のいちばん重い行（飢え・逃走・攻められた）に合わせる。朝の報告に赤い行が無ければ、
 * 今夜の危機（食料が今夜尽きる・今夜逃げる）を言う。どれも無ければ「いまの状況」— 誰が何人待っているか — を一言で。
 * やることカードと同じ文は言わない（SPEC-112 §2 E）。
 */
function homeLine(app, todo, ol) {
  const st = app.state;
  const me = st.playerLand;
  const land = landDef(app, me);
  const landNm = land ? land.nameJa || land.name : me;
  const pct = battery(st.day);
  const first = todo[0];
  const waiting = waitingSquads(app);
  const lead = waiting[0] ? heroOf(app, waiting[0]) : null;
  const summary = () => (waiting.length >= 2
    ? tf(app, 'navi.home.waitingMany', { name: lead ? lead.name : '', n: waiting.length })
    : waiting.length === 1 ? tf(app, 'navi.home.waitingOne', { name: lead ? lead.name : '' })
      : t(app, 'navi.home.waitingNone'));
  const rep = morningReport(app);
  const f = (rep && rep.flags) || {};
  const top = rep && rep.rows[0];
  // 朝の報告のいちばん重い行（赤）に合わせる
  if (top && top.level === 'bad') {
    // 赤い行のうち、攻められた → 逃げた → 飢えた の順に 1 つを、話し言葉で（数字は 1 つだけ）。
    // 行の種類で、表情と続きのひとことを変える（攻められた → 守り、逃走 → 恩賞か休息、飢え → 農作か配給）
    const bad = rep.rows.filter((r) => r.level === 'bad');
    const pick = bad.find((r) => r.kind === 'hit') || (f.desert ? { kind: 'desert' } : null) || bad.find((r) => r.kind === 'starve') || top;
    const k = pick.kind === 'starve' ? 'Starve' : pick.kind === 'desert' ? 'Desert' : 'Hit';
    const face = k === 'Starve' ? 'cry' : k === 'Desert' ? 'teary' : 'surprise';
    const head = k === 'Desert' ? L(app, 'homeF.navi.deserted', { n: fmt(f.desert) }) : pick.main;
    return { face, text: L(app, 'homeF.navi.top', { main: head, why: '' }) + L(app, `homeF.navi.after${k}`) };
  }
  // 今夜の危機
  if (ol.tonight) {
    const short = foodShortTonight(ol);
    return { face: 'teary', text: L(app, 'homeF.navi.tonight', { v: signed(MORALE_DELTA.starve) }) + (short > 0 ? L(app, 'homeF.navi.short', { n: fmt(short) }) : '') };
  }
  if (ol.desert.total > 0) return { face: 'trouble', text: L(app, 'homeF.navi.desertTonight', { n: fmt(ol.desert.total), k: ol.desert.squads }) };
  if (first && first.kind === 'soul') return { face: 'sparkle', text: t(app, 'navi.home.fortWin') };
  if (f.fortWin) return { face: 'happy', text: t(app, 'navi.home.fortWin') };
  if (f.homeHit) return { face: 'surprise', text: t(app, 'navi.home.homeHit') };
  const days = ol.plan.food.daysLeft;
  const hungry = days != null && days <= FOOD_WARN_DAYS;
  if (st.day === 1 && first && first.kind === 'hero' && first.status === 'none' && !hungry) return { face: 'wave', text: tf(app, 'navi.home.welcome', { land: landNm }) };
  if (hungry) return { face: 'trouble', text: summary() };
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

// ------------------------------------------------------------
// 朝の報告（SPEC-114 §2.1・§6 の週報）
//   実行フェーズが終わったとき（main.js の finishExecute）に buildMorning で 1 度だけ作り、state.morning に保存する
//   （再読み込みしても消えない。畳んだかどうかも state.morning.closed に残す）。
//   材料は実行フェーズのイベント・実行前の控え（morningSnapshot）・いまの forecast。
//   兵の差し引きは、部隊ごとにイベントの順で兵をたどって理由ごとに分ける（逃走・戦闘・徴兵・休息・スキルの回復・
//   敗走から戻った・夜の回復）。夜の回復はイベントが無いので、たどったあとの残り（敗走していない部隊）。
//   ヒーローのセリフは行に使わない（何が起きたかを、誰が・どこで・何人で書く）。
// ------------------------------------------------------------

/** 報告に出す行の数（残りは「ほか N 件」） */
export const MORNING_MAX = 2;
/** 週報があるときに出す行の数 */
const MORNING_MAX_WEEK = 1;
/** 士気の平均がこれだけ動いたら報告する */
const MORALE_REPORT_DELTA = 5;

const REASON_KEY = {
  starve: 'starve', fed: 'fed', home: 'home', ration: 'ration', commander: 'commander', rest: 'rest', reward: 'reward',
  win: 'win', lose: 'lose', ambushed: 'ambushed', routed: 'routed', fort: 'fort', skill: 'skill', surrender: 'surrender',
};

/** 止まった指示の理由（turn.execute の blocked.reason）。ほかは「進めなかった」 */
const BLOCKED_WHY = ['enemy', 'build', 'target', 'range', 'claim', 'terrain', 'ap', 'home', 'gum'];

/** 兵の内訳の並び（文に出す順） */
const TROOP_PARTS = ['desert', 'battle', 'back', 'conscript', 'rest', 'heal', 'recover', 'joined', 'left', 'other'];

/** 実在のランド（エネミー以外） */
function realLandIds(st) {
  return Object.keys(st.lands).filter((id) => id !== 'enemy');
}

/** 砦ポイントの順位（同点は同じ順位） */
function rankOf(st, id, pts = (x) => st.lands[x].fortPoints || 0) {
  const mine = pts(id);
  return 1 + realLandIds(st).filter((x) => x !== id && pts(x) > mine).length;
}

function landName(app, id) {
  if (id === 'enemy') return L(app, 'homeF.enemyLand');
  const d = landDef(app, id);
  return d ? d.nameJa || d.name : id;
}

/** 週報（week_end イベントの points から、先週の順位を引き戻す）。保存できる形（名前まで文字にする） */
function weeklyOf(app, evs) {
  const ev = evs.find((e) => e.t === 'week_end');
  if (!ev) return null;
  const st = app.state;
  const now = (x) => st.lands[x].fortPoints || 0;
  const prev = (x) => now(x) - ((ev.points || {})[x] || 0);
  const ids = realLandIds(st);
  const rows = ids.map((id) => ({
    id, name: landName(app, id), pts: now(id), gain: (ev.points || {})[id] || 0,
    rank: rankOf(st, id, now), before: rankOf(st, id, prev), me: id === st.playerLand,
  })).sort((a, b) => a.rank - b.rank || (a.me ? -1 : b.me ? 1 : 0) || a.name.localeCompare(b.name, 'ja'));
  return { week: ev.week, rows };
}

/** 部隊のヒーロー名（いまの state か、無ければ id） */
function squadName(app, id) {
  const s = app.state.squads[id];
  const hh = s ? heroOf(app, s) : null;
  return hh ? hh.name : String(id);
}

/** 戦闘の場所（本拠地 / 砦の名前 / 自領 / ○○の領地 / 中立の土地） */
function placeOf(app, tile) {
  const st = app.state;
  const me = st.playerLand;
  if (tile == null) return '';
  for (const id of realLandIds(st)) if (st.lands[id].home === tile) return id === me ? L(app, 'homeF.place.home') : L(app, 'homeF.place.theirHome', { land: landName(app, id) });
  const fort = Object.values(st.forts || {}).find((f) => f.tile === tile);
  if (fort) return fort.name;
  const t = st.map.tiles[tile];
  if (t && t.owner === me) return L(app, 'homeF.place.own');
  if (t && t.owner && t.owner !== 'enemy') return L(app, 'homeF.place.their', { land: landName(app, t.owner) });
  return L(app, 'homeF.place.wild');
}

/** 攻めた先の名前（部隊ならヒーロー、砦なら砦の名前、本拠地なら「○○の本拠地」） */
function targetLabel(app, ev) {
  const st = app.state;
  if (ev.target === 'home') return L(app, 'homeF.place.theirHome', { land: landName(app, ev.defender) });
  if (st.forts && st.forts[ev.defender]) return st.forts[ev.defender].name;
  return squadName(app, ev.defender);
}

/**
 * 兵の差し引きを理由ごとに分ける（自ランドの部隊だけ）。
 * 実行前の控えの兵から、イベントの順に 徴兵 / 休息 / 逃走 / 戦闘（打撃・反撃・回復スキル）を当てていき、
 * 最後に残った差を「敗走から戻った」（敗走した部隊。beginTurn が統率力 × 3 で戻す）か「夜の回復」とする。
 * 内訳の合計は必ず「いまの兵 − 実行前の兵」（兵のウィジェットの前日差）に一致する。
 * @returns {{ diff:number, parts:Map<string,number>, battles:Array, routed:Set<string> }}
 */
function troopAccount(app, base, evs) {
  const st = app.state;
  const me = st.playerLand;
  const all = (base && base.all) || {};
  const cur = new Map();
  for (const id of Object.keys(all)) cur.set(id, all[id].troops);
  const troopsOf = (id) => (cur.has(id) ? cur.get(id) : Math.max(0, (st.squads[id] && st.squads[id].troops) || 0));
  const wasMine = (id) => !!all[id] && all[id].land === me;
  const parts = new Map();
  const add = (id, key, v) => {
    if (!v || !wasMine(id)) return;
    parts.set(key, (parts.get(key) || 0) + v);
  };
  const isSquad = (id) => all[id] != null || st.squads[id] != null;
  const routed = new Set();
  const battles = [];
  for (const e of evs) {
    if (e.t === 'domestic' && e.kind === 'conscript' && e.amount) {
      cur.set(e.squad, troopsOf(e.squad) + e.amount);
      add(e.squad, 'conscript', e.amount);
    } else if (e.t === 'rest' && e.amount) {
      cur.set(e.squad, troopsOf(e.squad) + e.amount);
      add(e.squad, 'rest', e.amount);
    } else if (e.t === 'desert') {
      cur.set(e.squad, Math.max(0, troopsOf(e.squad) - e.amount));
      add(e.squad, 'desert', -e.amount);
    } else if (e.t === 'routed') {
      routed.add(e.squad);
    } else if (e.t === 'battle') {
      const a = e.attacker;
      const d = isSquad(e.defender) ? e.defender : null;
      const before = { a: troopsOf(a), d: d ? troopsOf(d) : 0 };
      if (e.skill && e.skill.kind === 'heal' && e.skill.value) {
        cur.set(a, troopsOf(a) + e.skill.value);
        add(a, 'heal', e.skill.value);
      }
      let defLoss = 0;
      if (!e.evaded && d) {
        defLoss = Math.min(e.dmg || 0, troopsOf(d));
        cur.set(d, troopsOf(d) - defLoss);
        add(d, 'battle', -defLoss);
      }
      let atkLoss = 0;
      if (e.counter) {
        if (d && e.counter.skill && e.counter.skill.kind === 'heal' && e.counter.skill.value) {
          cur.set(d, troopsOf(d) + e.counter.skill.value);
          add(d, 'heal', e.counter.skill.value);
        }
        if (!e.counter.evaded) {
          atkLoss = Math.min(e.counter.dmg || 0, troopsOf(a));
          cur.set(a, troopsOf(a) - atkLoss);
          add(a, 'battle', -atkLoss);
        }
      }
      const fu = e.followups || [];
      battles.push({
        ev: e, d, defLoss, atkLoss, before,
        atkRouted: fu.some((f) => f.t === 'routed' && f.squad === a),
        defRouted: !!d && fu.some((f) => f.t === 'routed' && f.squad === d),
      });
    }
  }
  // 残り（夜の回復・敗走から戻った）と、ランドを移った部隊
  const ids = new Set([...Object.keys(all).filter(wasMine), ...Object.values(st.squads).filter((s) => s.land === me).map((s) => s.id)]);
  let now = 0;
  let was = 0;
  for (const id of ids) {
    const s = st.squads[id];
    const mineNow = !!s && s.land === me;
    const t = mineNow ? Math.max(0, s.troops || 0) : 0;
    if (mineNow) now += s.troops || 0;
    if (wasMine(id)) was += all[id].troops;
    if (mineNow && !wasMine(id)) { parts.set('joined', (parts.get('joined') || 0) + t); continue; }
    if (!mineNow) { parts.set('left', (parts.get('left') || 0) - troopsOf(id)); continue; }
    const rest = t - troopsOf(id);
    if (!rest) continue;
    const key = routed.has(id) ? 'back' : rest > 0 ? 'recover' : 'other';
    parts.set(key, (parts.get(key) || 0) + rest);
  }
  return { diff: now - was, parts, battles, routed };
}

/** 戦闘の部分の注記（誰が減ったか。攻められたならどのランドに） */
function battleNote(app, acc, me) {
  const st = app.state;
  const loss = new Map();
  const by = new Set();
  let attacked = false;
  let attacking = false;
  for (const b of acc.battles) {
    const a = st.squads[b.ev.attacker];
    const aMine = b.ev.attacker && ((a && a.land === me) || false);
    const dMine = b.d && st.squads[b.d] && st.squads[b.d].land === me;
    if (dMine && b.defLoss) {
      loss.set(b.d, (loss.get(b.d) || 0) + b.defLoss);
      attacked = true;
      if (a) by.add(landName(app, a.land));
    }
    if (aMine && b.atkLoss) {
      loss.set(b.ev.attacker, (loss.get(b.ev.attacker) || 0) + b.atkLoss);
      attacking = true;
    }
  }
  if (!loss.size) return '';
  // 1 部隊なら名前まで、2 部隊以上なら攻めてきたランドだけ（誰がどこで何人かは、攻められた行に 1 部隊ずつ）
  const names = [...loss.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => squadName(app, id));
  const byText = attacked && !attacking && by.size ? [...by].join('・') : null;
  if (names.length === 1) return byText ? L(app, 'homeF.battleBy', { who: names[0], by: byText }) : names[0];
  return byText ? L(app, 'homeF.battleByOnly', { by: byText }) : L(app, 'homeF.squadsN', { n: names.length });
}

/** 兵の行（先頭行。主文の ±N は兵のウィジェットの前日差と同じ数） */
function troopsRow(app, base, acc) {
  const st = app.state;
  const parts = acc.parts;
  const keys = TROOP_PARTS.filter((k) => parts.get(k));
  if (!acc.diff && !keys.length) return null;
  // 夜の回復だけ（人口の自然増が毎晩少しずつ兵に変わる）なら、知らせるほどのことではない。
  // 実行前に人口が残っていた（その人口を回復に使い切った）日だけ出す
  if (keys.length === 1 && keys[0] === 'recover' && !((base.res && base.res.pop) > 0)) return null;
  const note = battleNote(app, acc, st.playerLand);
  const why = keys.map((k) => {
    const s = `${L(app, `homeF.part.${k}`)} ${signed(parts.get(k))}`;
    return k === 'battle' && note ? `${s}（${note}）` : s;
  }).join('・');
  const bad = (parts.get('desert') || 0) < 0 || (acc.diff < 0 && (parts.get('battle') || 0) < 0);
  return { kind: (parts.get('desert') || 0) < 0 ? 'desert' : 'troops', level: bad ? 'bad' : 'info', order: bad ? 1 : 39, main: `${L(app, 'morning.troops')} ${signed(acc.diff)}`, why, go: { ledger: 'troops' } };
}

/**
 * 自国の戦闘の行。攻められた部隊は赤で先頭に（誰が・どこで・何人）、攻めた戦闘は 敵 −N・自 −N と、
 * 指示したときの見込み（app.ui.mapPred。Map が控える）との比べ。セリフは使わない。
 */
function battleRows(app, base, acc) {
  const st = app.state;
  const me = st.playerLand;
  const rows = [];
  const mine = (id) => st.squads[id] && st.squads[id].land === me;
  // 攻められた（部隊ごとにまとめる）
  const hitMe = new Map();
  for (const b of acc.battles) {
    if (!b.d || !mine(b.d) || mine(b.ev.attacker)) continue;
    const a = st.squads[b.ev.attacker];
    const g = hitMe.get(b.d) || { loss: 0, lands: new Set(), places: new Set(), routed: false, ambush: false, won: false };
    g.loss += b.defLoss;
    if (a) g.lands.add(landName(app, a.land));
    g.places.add(placeOf(app, b.ev.at));
    g.routed = g.routed || b.defRouted;
    g.ambush = g.ambush || !!b.ev.ambush;
    g.won = g.won || b.atkRouted;
    hitMe.set(b.d, g);
  }
  for (const [id, g] of hitMe) {
    const name = squadName(app, id);
    const why = [L(app, 'homeF.hit.by', { land: [...g.lands].join('・') || L(app, 'homeF.enemyLand'), place: [...g.places].filter(Boolean).join('・') })];
    if (g.ambush) why.push(L(app, 'homeF.hit.ambush'));
    if (g.routed) why.push(L(app, 'homeF.hit.routed'));
    else if (g.won) why.push(L(app, 'homeF.hit.repelled'));
    const tile = acc.battles.find((b) => b.d === id).ev.at;
    if (g.loss > 0 || g.routed) {
      rows.push({ kind: 'hit', level: 'bad', order: 1, main: L(app, 'homeF.hit.main', { name, v: signed(-g.loss) }), why: why.join('・'), go: { app: 'map', tile } });
    } else {
      rows.push({ level: 'good', order: 20, main: L(app, 'homeF.hit.held', { name }), why: why.join('・'), go: { app: 'map', tile } });
    }
  }
  // 攻めた（1 戦ずつ）
  const m = app.ui.mapPred;
  const preds = m && base && m.day === base.day ? m.list || {} : {};
  for (const b of acc.battles) {
    const ev = b.ev;
    if (!mine(ev.attacker)) continue;
    const name = squadName(app, ev.attacker);
    const self = b.atkRouted ? L(app, 'homeF.atk.selfRouted', { v: signed(-b.atkLoss) }) : L(app, 'homeF.atk.self', { v: signed(-b.atkLoss) });
    let foe;
    if (ev.result === 'fort_fallen') foe = L(app, 'homeF.atk.fortFallen', { target: targetLabel(app, ev) });
    else if (ev.result === 'home_fallen') foe = L(app, 'homeF.atk.homeFallen', { target: targetLabel(app, ev) });
    else if (b.d) foe = L(app, b.defRouted ? 'homeF.atk.foeRouted' : 'homeF.atk.foe', { v: signed(-b.defLoss) });
    else foe = ev.evaded ? L(app, 'homeF.atk.missed') : L(app, 'homeF.atk.dmg', { target: targetLabel(app, ev), n: fmt(ev.dmg || 0) });
    // 見込みとの比べ（部隊どうしのときだけ。予想は「兵の残り」の幅なので、減った量の幅に直して比べる）
    let pred = '';
    const p = preds[`${ev.attacker}@${ev.at}`];
    if (p && p.attacker && (!b.d || p.defenderId == null || p.defenderId === ev.defender)) {
      const selfIn = b.atkLoss >= p.attacker.before - p.attacker.max && b.atkLoss <= p.attacker.before - p.attacker.min;
      const foeIn = !b.d || !p.defender || (b.defLoss >= p.defender.before - p.defender.max && b.defLoss <= p.defender.before - p.defender.min);
      pred = selfIn && foeIn ? L(app, 'homeF.atk.asPredicted')
        : L(app, 'homeF.atk.predicted', { a: signed(-(p.attacker.before - p.attacker.min)), b: signed(-(p.attacker.before - p.attacker.max)) });
    }
    const won = b.defRouted || ev.result === 'fort_fallen' || ev.result === 'home_fallen' || (b.d && b.defLoss > b.atkLoss);
    // 負けた（与えたより受けた兵が多い）戦闘は黄。勝った・互角は緑 / 灰
    const level = b.atkRouted ? 'bad' : won ? 'good' : b.atkLoss > b.defLoss ? 'warn' : 'info';
    rows.push({
      level, order: b.atkRouted ? 2 : level === 'warn' ? 3 : 20,
      main: L(app, 'homeF.atk.main', { name, foe, self }),
      why: [b.d ? L(app, 'homeF.atk.vs', { target: targetLabel(app, ev) }) : '', pred].filter(Boolean).join('・'),
      go: { app: 'map', tile: ev.at },
    });
  }
  return rows;
}

/** 資源 1 つの差し引き（実行前の控え → いま）と、その内訳（イベントの量。人口の兵の回復は兵の内訳から） */
function resLine(app, k, base, evs, acc) {
  const st = app.state;
  const me = st.playerLand;
  const cur = Math.floor(st.lands[me].res[k] || 0);
  const diff = cur - Math.floor(base.res[k] || 0);
  if (!diff) return null;
  const parts = new Map();
  const add = (key, v) => { if (v) parts.set(key, (parts.get(key) || 0) + v); };
  for (const e of evs) {
    const s = e.squad ? st.squads[e.squad] : null;
    if (e.t === 'domestic' && s && s.land === me) {
      if (e.kind === 'farm' && k === 'food') add('farm', e.amount);
      else if (e.kind === 'craft' && k === 'mat') add('craft', e.amount);
      else if (e.kind === 'trade' && k === 'gum') add('trade', e.amount);
      else if (e.kind === 'conscript' && k === 'pop') add('conscript', -e.amount);
      else if (e.kind === 'reward' && k === 'gum') add('reward', -(e.cost || 0));
    } else if (e.t === 'rest' && s && s.land === me && k === 'pop') add('rest', -e.amount);
    else if (e.t === 'build_start' && s && s.land === me && (k === 'gum' || k === 'mat')) add('build', -(buildCost(app.db, e.kind)[k] || 0));
    else if (e.t === 'yield' && e.land === me) add(k === 'pop' ? 'growth' : 'yield', (e.res || {})[k] || 0);
  }
  if (k === 'pop') add('recover', -((acc.parts.get('recover') || 0)));
  let known = 0;
  for (const v of parts.values()) known += v;
  if (diff - known) add('other', diff - known);
  const why = [...parts.entries()].filter(([, v]) => v).map(([key, v]) => `${L(app, key === 'recover' ? 'homeF.part.popRecover' : key === 'build' ? 'homeF.part.build' : `morning.part.${key}`)} ${signed(v)}`).join('・');
  return { level: 'info', order: 40 + ['food', 'gum', 'mat', 'pop'].indexOf(k), main: `${t(app, `res.${k}`)} ${signed(diff)}`, why, go: { ledger: k } };
}

/**
 * 朝の報告を作る（main.js の finishExecute が、beginTurn のあとに 1 度だけ呼ぶ）。保存できる形で返す。
 * 行は重大なものから: 飢え・逃走・攻められた（赤）→ 自国の戦闘・占領された（赤 / 緑）→ 士気・人口 0（黄）
 * → 資源の差し引き（灰）→ 他国の動き（灰）。
 * @param {object} prev 前の朝の state.morning（人口 0 の知らせを 1 回だけにするため）
 * @returns {{day, rows: Array<{level, order, main, why, go}>, weekly, closed:boolean, popZero:boolean, flags:object}}
 */
export function buildMorning(app, base, events, prev = null) {
  const st = app.state;
  const me = st.playerLand;
  const evs = events || [];
  const fc = forecast(st, app.db, me);
  const rows = [];
  const mine = (id) => st.squads[id] && st.squads[id].land === me;
  const note = (ev) => noticesFrom(st, app.db, [ev])[0] || null;
  const acc = troopAccount(app, base, evs);
  const flags = { starve: false, desert: 0, fortWin: false, routed: false, homeHit: false };

  // 赤: 飢え
  // 飢えが続いている（きのうの朝も飢えていた）なら、新しい知らせではないので、攻められた・逃げたの後ろへ
  const starvedBefore = !!(prev && prev.flags && prev.flags.starve && prev.day === st.day - 1);
  for (const e of evs) {
    if (e.t === 'starve' && e.land === me) {
      flags.starve = true;
      rows.push({ kind: 'starve', level: 'bad', order: starvedBefore ? 2.5 : 0, main: L(app, 'morning.starve', { n: fmt(e.shortfall || 0) }), why: L(app, 'morning.starveWhy', { v: signed(MORALE_DELTA.starve) }), go: { ledger: 'food' } });
    }
  }
  // 逃げた兵の数（ナビゲーターのひとこと用）
  flags.desert = evs.filter((e) => e.t === 'desert' && mine(e.squad)).reduce((x, e) => x + (e.amount || 0), 0);
  // 兵（先頭行。逃走・攻められて減ったなら赤）
  if (base) {
    const tr = troopsRow(app, base, acc);
    if (tr) rows.push(tr);
  }
  // 自国の戦闘（攻められた・攻めた）
  const br = battleRows(app, base, acc);
  rows.push(...br);
  flags.routed = acc.battles.some((b) => (b.defRouted && mine(b.d)) || (b.atkRouted && mine(b.ev.attacker)));
  // 占領された・落とした・本拠地・止まった指示
  for (const e of evs) {
    if (e.t === 'fort_fallen' && (e.from === me || e.by === me)) {
      const n = note(e);
      if (e.by === me) flags.fortWin = true;
      if (n && e.from === me) rows.push({ level: 'bad', order: 2, main: n.text, why: '', go: { app: 'map', tile: n.tile } });
    } else if (e.t === 'home_fallen' && (e.land === me || e.by === me)) {
      const n = note(e);
      if (n) rows.push({ level: e.land === me ? 'bad' : 'good', order: 2, main: n.text, why: '', go: { app: n.app || 'map' } });
    } else if (e.t === 'battle' && e.target === 'home' && e.defender === me) {
      flags.homeHit = true;
    } else if (e.t === 'blocked' && mine(e.squad)) {
      rows.push({ level: 'warn', order: 3, main: L(app, 'homeF.blocked', { name: squadName(app, e.squad) }), why: L(app, `homeF.blocked.${BLOCKED_WHY.includes(e.reason) ? e.reason : 'other'}`), go: { app: 'chat', squad: e.squad } });
    }
  }
  // 黄: 士気の大きな変化（平均）と、0 / 動揺に落ちた部隊
  if (base && base.moraleAvg != null && fc.morale.avg != null && Math.abs(fc.morale.avg - base.moraleAvg) >= MORALE_REPORT_DELTA) {
    const weight = new Map();
    const sign = new Map();
    const ration = rationOf(st.lands[me]);
    // 毎日の変化の理由の向き（まとめの delta は理由ごとに分かれていないので、理由の決まった向きで分ける）
    const DAY_SIGN = { starve: -1, fed: 1, home: 1, commander: 1, ration: ration === 'save' ? -1 : 1 };
    const signOf = (r) => (sign.has(r) ? sign.get(r) : DAY_SIGN[r] || 0);
    for (const e of evs) {
      if (e.t === 'morale' && mine(e.squad)) sign.set(e.reason, Math.sign((sign.get(e.reason) || 0) + Math.sign(e.delta)));
    }
    for (const e of evs) {
      if (e.t === 'morale_day' && e.land === me) {
        for (const c of e.changes || []) for (const r of c.reasons || []) weight.set(r, (weight.get(r) || 0) + Math.abs(c.delta) / Math.max(1, (c.reasons || []).length));
      } else if (e.t === 'morale' && mine(e.squad)) weight.set(e.reason, (weight.get(e.reason) || 0) + Math.abs(e.delta));
    }
    const down = fc.morale.avg < base.moraleAvg;
    const top = [...weight.entries()].filter(([r]) => signOf(r) === 0 || (signOf(r) < 0) === down)
      .sort((a, b) => b[1] - a[1]).slice(0, 2).map(([r]) => L(app, `morning.reason.${REASON_KEY[r] || 'other'}`));
    rows.push({
      level: down ? 'warn' : 'info', order: down ? 3 : 38,
      main: L(app, 'morning.morale', { from: base.moraleAvg, to: fc.morale.avg }),
      why: top.join('・'), go: { ledger: 'troops' },
    });
  }
  for (const e of evs) {
    if (e.t !== 'morale_day' || e.land !== me) continue;
    for (const x of noticesFrom(st, app.db, [e])) rows.push({ level: 'warn', order: 3, main: x.text, why: '', go: { ledger: 'troops' } });
  }
  // 黄: 人口 0（兵の回復も徴兵も止まる）。0 になった朝に 1 回だけ。人口が戻ったら、また 0 になったときに出す
  const pop = Math.floor(st.lands[me].res.pop || 0);
  const popZero = pop <= 0;
  if (popZero && !(prev && prev.popZero)) {
    rows.push({ level: 'warn', order: 3, main: L(app, 'homeF.popZero'), why: L(app, 'homeF.popZeroWhy'), go: { ledger: 'pop' } });
  }
  // 灰: 資源の差し引き
  if (base) {
    for (const k of ['food', 'gum', 'mat', 'pop']) {
      const r = resLine(app, k, base, evs, acc);
      if (r) rows.push(r);
    }
  }
  // 灰: 占領・完成
  const claims = evs.filter((e) => e.t === 'claim' && e.land === me).length;
  if (claims) rows.push({ level: 'info', order: 45, main: L(app, 'morning.claim', { n: claims }), why: '', go: { app: 'map' } });
  for (const e of evs) {
    if (e.t === 'build_done' && e.land === me) {
      const n = note(e);
      if (n) rows.push({ level: 'info', order: 46, main: n.text, why: '', go: { app: 'map', tile: n.tile } });
    }
  }
  // 灰: 他国の動き
  for (const e of evs) {
    const other = (e.t === 'fort_fallen' && e.from !== me && e.by !== me) || (e.t === 'home_fallen' && e.land !== me && e.by !== me) || (e.t === 'clear');
    if (!other) continue;
    const n = note(e);
    if (n) rows.push({ level: 'info', order: 50, main: n.text, why: '', go: { app: n.app || 'map', tile: n.tile } });
  }
  rows.forEach((r, i) => { r.i = i; });
  const LV = { bad: 0, good: 1, warn: 2, info: 3 };
  rows.sort((a, b) => a.order - b.order || LV[a.level] - LV[b.level] || a.i - b.i);
  for (const r of rows) delete r.i;
  return { day: st.day, rows, weekly: weeklyOf(app, evs), closed: false, popZero, flags, check: { diff: acc.diff, troops: fc.troops.total, base: base ? base.troops : null } };
}

/** その日の朝の報告（state.morning。日が違えば null） */
export function morningReport(app) {
  const st = app.state;
  const m = st && st.morning;
  if (!m || m.day !== st.day) return null;
  return m;
}

/** 行の行き先（保存した go を、画面の切り替えに） */
function rowAct(app, r) {
  const g = r.go || {};
  if (g.ledger) return () => openLedger(app, g.ledger);
  if (g.app) return () => go(g.app, { ...(g.tile != null ? { tile: g.tile } : {}), ...(g.squad != null ? { squad: g.squad } : {}) });
  return null;
}

function mRow(app, r) {
  const act = rowAct(app, r);
  return h('li', { class: ['mrow', `is-${r.level}`] },
    h('button', { class: 'mrow__btn', type: 'button', onClick: () => act && act() },
      h('span', { class: 'mrow__mark', 'aria-label': L(app, `morning.level.${r.level}`) }, r.level === 'good' ? '+' : r.level === 'info' ? '' : '!'),
      h('span', { class: 'mrow__text' },
        h('span', { class: 'mrow__main num' }, r.main),
        r.why ? h('span', { class: 'mrow__why' }, r.why) : null),
      h('span', { class: 'mrow__go', 'aria-hidden': 'true' })));
}

function weekBlock(app, w, all = false) {
  // 畳んだ報告では 1 位と自分の行だけ（全部は「ほか N 件」の中）
  const rows = all ? w.rows : w.rows.filter((r, i) => i < 1 || r.me);
  return h('div', { class: 'mweek' },
    h('p', { class: 'mweek__title' }, L(app, 'morning.week', { n: w.week })),
    h('ol', { class: 'mweek__list' }, rows.map((r) => {
      const d = r.before - r.rank;
      return h('li', { class: ['mweek__row', r.me ? 'is-me' : null] },
        h('span', { class: 'mweek__rank num' }, L(app, 'morning.rank', { n: r.rank })),
        h('span', { class: ['mweek__move', d > 0 ? 'is-up' : d < 0 ? 'is-down' : 'is-flat'], 'aria-label': d > 0 ? L(app, 'morning.up', { n: d }) : d < 0 ? L(app, 'morning.down', { n: -d }) : L(app, 'morning.flat') },
          d > 0 ? `▲${d}` : d < 0 ? `▼${-d}` : '→'),
        h('span', { class: 'mweek__name' }, r.me ? `${r.name}${L(app, 'morning.you')}` : r.name),
        h('span', { class: 'mweek__pts num' }, `${r.pts}pt`),
        h('span', { class: ['mweek__gain', 'num', r.gain > 0 ? 'is-up' : null] }, signed(r.gain)));
    })));
}

/** 全部の行と、これまでの通知をポップアップで（朝の報告の「ほか N 件」・通知の 1 行から） */
function openMorningAll(app, rep, focusNotices = false) {
  const notices = (app.state.notices || []).slice(-NOTICE_LIST_MAX).reverse();
  const head = notices.length ? h('h3', { class: 'section-title morning-all__notices' }, t(app, 'home.notices'), ' ', h('span', { class: 'home__notices-count num' }, String(notices.length))) : null;
  const body = h('div', { class: 'morning-all' },
    rep && rep.weekly ? weekBlock(app, rep.weekly, true) : null,
    rep && rep.rows.length ? h('ul', { class: 'morning__rows morning__rows--all' }, rep.rows.map((r) => mRow(app, r))) : null,
    head,
    notices.length ? h('ul', { class: 'notice-list notice-list--all' }, notices.map((n) => noticeItem(app, n))) : h('p', { class: 'muted' }, t(app, 'home.noNotices')),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn-secondary', type: 'button', onClick: () => closePopup() }, t(app, 'common.close'))));
  openPopup(body, { title: rep ? L(app, 'morning.title') : t(app, 'home.notices') });
  if (focusNotices && head && head.scrollIntoView) head.scrollIntoView({ block: 'start' });
}

function morningCard(app, face = 'normal') {
  const st = app.state;
  const rep = morningReport(app);
  if (!rep || rep.closed || (!rep.rows.length && !rep.weekly)) return null;
  const max = rep.weekly ? MORNING_MAX_WEEK : MORNING_MAX;
  const shown = rep.rows.slice(0, max);
  const rest = rep.rows.length - shown.length;
  const top = rep.rows[0] ? rep.rows[0].level : 'info';
  const card = h('section', { class: ['morning', `is-${top}`, rep.weekly ? 'has-week' : null], 'aria-labelledby': 'morning-title', dataset: { rows: rep.rows.length } },
    h('header', { class: 'morning__head' },
      // ナビゲーターが読み上げる報告（舞台の代わりに、顔だけを報告の頭に）
      h('span', { class: ['morning__navi', `navi--${NAVI_FACES[face] ? face : 'normal'}`], 'aria-hidden': 'true' },
        imgEl(naviPath(face), '', { class: 'morning__navi-img pixel', draggable: 'false' })),
      h('h2', { class: 'morning__title', id: 'morning-title' }, rep.weekly ? L(app, 'morning.titleWeek') : L(app, 'morning.title')),
      h('span', { class: 'morning__day num' }, `${t(app, 'status.day')} ${Math.min(st.day, 28)}`),
      rest > 0 || (st.notices || []).length
        ? h('button', { class: 'morning__more', type: 'button', onClick: () => openMorningAll(app, rep) }, rest > 0 ? L(app, 'morning.more', { n: rest }) : t(app, 'home.notices'))
        : null,
      h('button', {
        class: 'morning__x', type: 'button', 'aria-label': L(app, 'morning.close'),
        onClick: () => closeMorning(app, card),
      }, '×')),
    rep.weekly ? weekBlock(app, rep.weekly) : null,
    shown.length ? h('ul', { class: 'morning__rows' }, shown.map((r) => mRow(app, r))) : null);
  return card;
}

function closeMorning(app, card) {
  const m = morningReport(app);
  if (m) {
    m.closed = true;
    try { save(app.state); } catch (e) { console.error(e); }
  }
  const done = () => { if (app.ui.app === 'home') homeRerender(); };
  if (!card || fx.reducedMotion() || !card.animate) { done(); return; }
  const hgt = card.offsetHeight;
  card.style.overflow = 'hidden';
  card.animate([
    { opacity: 1, height: `${hgt}px`, transform: 'none' },
    { opacity: 0, height: '0px', marginBottom: '-10px', paddingTop: '0px', paddingBottom: '0px', transform: 'translateY(-8px) scale(.98)' },
  ], { duration: fx.token('--t-ui', 240) * 1.2, easing: 'cubic-bezier(.55, 0, .75, .2)', fill: 'forwards' }).finished.then(done, done);
}

/** ホームだけを描き直す（main.render を遅延で呼ぶ。循環 import の初期化順に依存しないため） */
function homeRerender() {
  import('../main.js').then((m) => m.render());
}

// ------------------------------------------------------------
// 資源のウィジェット（SPEC-114 §2.2）
// ------------------------------------------------------------

function resRow(app, land, ol) {
  const keys = ['gum', 'food', 'mat', 'pop'];
  return h('div', { class: 'res-row', role: 'list' }, keys.map((k) => {
    const v = Math.floor((land.res && land.res[k]) || 0);
    const b = ol.base[k];
    const d = b.net;
    let chip = null;
    let delta = `${signed(d)}${L(app, 'ledger.perDay')}`;
    let sub = null;
    if (k === 'food' && ol.foodStock <= 0 && ol.plan.food.net < 0) {
      // 残高 0: もう尽きている。「今夜尽きる」ではなく、毎晩の不足と罰の大きさ
      chip = { level: 'bad', text: L(app, 'homeF.w.starving', { v: signed(MORALE_DELTA.starve) }) };
      delta = L(app, 'homeF.w.short', { v: signed(ol.plan.food.net) });
    } else if (k === 'pop') {
      // 人口は兵の回復で減るだけなので「あと N 日」は出さない。かわりに、何に使われるか・今夜 0 になるか
      const recover = b.expense.filter((r) => r.key === 'recover').reduce((a, r) => a + r.value, 0);
      if (recover > 0 && b.stock > 0 && b.stock + b.net <= 0) chip = { level: 'warn', text: L(app, 'homeF.w.popOut') };
      sub = b.stock <= 0 ? L(app, recover > 0 ? 'homeF.w.popGrowth' : 'homeF.w.popZero') : recover > 0 ? L(app, 'homeF.w.popRecover') : null;
    } else {
      // 「あと N 日」は、積んだ指示のあとで今夜を迎えたときの見込み
      chip = daysChip(app, ol.plan[k].daysLeft);
    }
    const label = t(app, `res.${k}`);
    return h('button', {
      class: ['res', `res--${k}`, chip ? `is-${chip.level}` : null], type: 'button', role: 'listitem', dataset: { res: k },
      'aria-label': `${label} ${v}${b.cap != null ? ` / ${b.cap}` : ''}、${L(app, 'home.w.perDayAria')} ${signed(d)}${sub ? `、${sub}` : ''}${chip ? `、${chip.text}` : ''}。${L(app, 'home.w.open')}`,
      onClick: () => openLedger(app, k),
    },
    h('span', { class: 'res__head' }, imgEl(RES_ICON[k], '', { class: 'res__icon', 'aria-hidden': 'true' }), h('span', { class: 'res__name' }, label)),
    h('span', { class: 'res__val num', dataset: { to: v } }, String(v)),
    h('span', { class: ['res__delta', 'num', d > 0 ? 'is-up' : d < 0 ? 'is-down' : null] }, delta),
    sub ? h('span', { class: 'res__sub' }, sub) : null,
    chip ? h('span', { class: ['res__warn', 'num', `is-${chip.level}`] }, chip.text) : null);
  }));
}

/**
 * 5 つ目のウィジェット: 兵と士気の平均（SPEC-114 §2.2）。兵は「兵 / 定員」（定員の合計 = forecast().troops.muster。
 * 夜の回復・休息で戻せるのは定員まで。SPEC-113 §2.1）。上限（統率力 × 10。徴兵でしか届かない）は内訳シートに出す。
 * 逃走のチップは、士気 0 の部隊がいま居る日は「逃走中」、今夜 0 になる見込みだけの日は「今夜から逃走」。
 * 数は積んだ指示のあとの夜（ol.night = planNight）の全部隊の合計と部隊の数（今日のやることと同じ数）。
 */
function troopsBar(app, ol) {
  const fc = ol.fc;
  const ds = ol.desert;
  let chip = null;
  if (ds.total > 0) {
    const zeroNow = ol.night.desert.some((d) => moraleOf(app.state.squads[d.squad]) === 0);
    const key = zeroNow ? 'homeF.w.deserting' : 'homeF.w.desertFrom';
    chip = { level: 'bad', text: L(app, ds.squads > 1 ? `${key}N` : key, { n: fmt(ds.total), k: ds.squads }) };
  } else if (fc.morale.deserting > 0) chip = { level: 'warn', text: L(app, 'home.w.zero', { n: fc.morale.deserting }) };
  else if (fc.morale.shaken > 0) chip = { level: 'warn', text: L(app, 'home.w.shaken', { n: fc.morale.shaken }) };
  return h('button', {
    class: ['troops-w', chip ? `is-${chip.level}` : null], type: 'button', dataset: { res: 'troops' },
    'aria-label': `${L(app, 'morning.troops')} ${fc.troops.total}、${L(app, 'home.w.musterAria', { n: fc.troops.muster })}、${L(app, 'ledger.moraleAvg')} ${fc.morale.avg == null ? '-' : fc.morale.avg}${chip ? `、${chip.text}` : ''}。${L(app, 'home.w.open')}`,
    onClick: () => openLedger(app, 'troops'),
  },
  h('span', { class: 'troops-w__icon', 'aria-hidden': 'true' }),
  h('span', { class: 'troops-w__label' }, L(app, 'morning.troops')),
  h('span', { class: 'troops-w__val num', dataset: { to: fc.troops.total } }, fmt(fc.troops.total)),
  h('span', { class: 'troops-w__cap num', 'aria-hidden': 'true' }, L(app, 'home.w.cap', { n: fmt(fc.troops.muster) })),
  h('span', { class: 'troops-w__sep', 'aria-hidden': 'true' }),
  h('span', { class: 'troops-w__label' }, L(app, 'ledger.morale')),
  fc.morale.avg == null ? h('span', { class: 'num' }, '-') : moraleGauge(app, fc.morale.avg, { cls: 'morale--w' }),
  chip ? h('span', { class: ['troops-w__chip', `is-${chip.level}`] }, chip.text) : null);
}

// ------------------------------------------------------------
// 状況の 1 行（SPEC-114 §2.3。初めて敵ランドを見つけた日から）
// ------------------------------------------------------------

/**
 * 砦ポイントの順位と、いちばん近い脅威。敵ランドを 1 つも見つけていなければ null。
 * 「見つけた」と兵の数は Drive の順位表と同じ決め方（探索済みのタイルに、そのランドのタイルか部隊がある。
 * 兵はそのランドの全部隊の合計 economy.totalTroops）。よそのランドの兵は指示フェーズのあいだ動かないので、朝の値と同じ。
 * 「近い」は、自分の本拠地から、そのランドの見えているタイル・部隊までのいちばん短いマス数。
 */
export function situationOf(app) {
  const st = app.state;
  const me = st.playerLand;
  const land = st.lands[me];
  const { w, h: hh, tiles } = st.map;
  const exp = new Set(land.explored || []);
  const others = new Set(realLandIds(st).filter((id) => id !== me && st.lands[id].alive !== false));
  const near = new Map(); // land → { d, tile, by:'tile'|'squad' }
  const look = (owner, tile, by) => {
    if (!others.has(owner) || land.home == null) return;
    const d = distance(land.home, tile, w, hh);
    const cur = near.get(owner);
    if (!cur || d < cur.d) near.set(owner, { d, tile, by });
  };
  for (const i of exp) if (tiles[i] && tiles[i].owner) look(tiles[i].owner, i, 'tile');
  for (const s of Object.values(st.squads)) {
    if (!others.has(s.land) || !exp.has(s.tile)) continue;
    look(s.land, s.tile, 'squad');
  }
  if (!near.size) return null;
  const [tid, tn] = [...near.entries()].sort((a, b) => a[1].d - b[1].d)[0];
  const fp = land.fortPoints || 0;
  const pts = realLandIds(st).map((id) => st.lands[id].fortPoints || 0);
  const rank = rankOf(st, me);
  const best = Math.max(...pts);
  const second = Math.max(0, ...realLandIds(st).filter((id) => id !== me).map((id) => st.lands[id].fortPoints || 0));
  const dow = dayOfWeek(Math.min(st.day, 28));
  return {
    fp, rank, gapTop: rank > 1 ? best - fp : fp - second, tallyIn: 6 - dow,
    // 全ランドが 0pt（まだ集計が 1 度も無い）なら、順位は何も言っていないので出さない
    ranked: best > 0,
    threat: { land: tid, name: landName(app, tid), tile: tn.tile, d: tn.d, by: tn.by, troops: totalTroops(st, tid) },
  };
}

/** ランド名の下の 1〜2 行: 砦ポイント（順位が意味を持つようになったら順位と 1 位との差）と、日曜の集計まで */
function landSub(app, me, sit) {
  if (!sit) {
    return h('span', { class: 'home__land-sub num' },
      h('span', { class: 'muted' }, t(app, 'drive.fortPoints')), ' ',
      h('strong', { class: 'home__fp', dataset: { to: me.fortPoints || 0 } }, String(me.fortPoints || 0)));
  }
  let rank = null;
  if (sit.ranked) {
    const gap = sit.rank > 1 ? L(app, 'home.sit.toTop', { v: signed(-sit.gapTop) }) : sit.gapTop > 0 ? L(app, 'home.sit.lead', { v: signed(sit.gapTop) }) : null;
    rank = gap ? L(app, 'home.sit.rankGap', { n: sit.rank, gap }) : L(app, 'home.sit.tie');
  }
  return h('button', { class: 'home__land-sub home__rank num', type: 'button', onClick: () => go('drive') },
    h('span', { class: 'home__rank-line' },
      h('span', { class: 'muted' }, t(app, 'drive.fortPoints')), ' ',
      h('strong', { class: 'home__fp', dataset: { to: sit.fp } }, String(sit.fp)),
      rank ? h('span', { class: 'muted' }, '・') : null,
      rank ? h('span', { class: 'home__rank-pos' }, rank) : null),
    h('span', { class: 'home__rank-line muted' }, sit.tallyIn <= 0 ? L(app, 'home.sit.tallyTonight') : L(app, 'home.sit.tallyFull', { n: sit.tallyIn })));
}

/**
 * いちばん近い脅威（2 行）。1 行目は基準（本拠地から N マス）、2 行目は「グレープ 兵 982（あなたの 2.2 倍）」。
 * 兵は Drive の順位表と同じ値。
 */
function threatRow(app, ol, sit) {
  if (!sit || sit.threat.troops == null) return null;
  const mineTotal = ol.fc.troops.total;
  const th = sit.threat;
  let ratio = null;
  if (mineTotal > 0) {
    const r = th.troops / mineTotal;
    ratio = L(app, 'home.sit.ratio', { r: r >= 10 ? r.toFixed(0) : r >= 1 ? r.toFixed(1) : r.toFixed(2) });
  }
  const strong = th.troops > mineTotal;
  return h('button', { class: ['home__threat', strong ? 'is-warn' : null], type: 'button', onClick: () => go('map', { tile: th.tile }) },
    h('span', { class: 'home__threat-k' },
      h('span', { class: 'sit__k' }, L(app, 'home.sit.threat')),
      h('span', { class: 'sit__sub num' }, L(app, th.by === 'squad' ? 'homeF.sit.basisSquad' : 'homeF.sit.basisTile', { d: th.d }))),
    h('span', { class: 'home__threat-v' },
      h('strong', { class: 'home__threat-name' }, th.name),
      h('span', { class: 'num' }, L(app, 'homeF.sit.troops', { n: fmt(th.troops) })),
      ratio ? h('span', { class: ['sit__ratio', 'num'] }, ratio) : null),
    h('span', { class: 'mrow__go', 'aria-hidden': 'true' }));
}

// ------------------------------------------------------------
// 今日のやることのカード
// ------------------------------------------------------------

/** 副題を行に分ける（文字列はそのまま 1 行。配列は <br> で区切った行） */
function subLines(sub) {
  if (!Array.isArray(sub)) return [String(sub == null ? '' : sub)];
  return sub.filter((x) => typeof x === 'string');
}

const KIND_FACE = { soul: 'is-accent', ext: 'is-accent', food: 'is-bad', ration: 'is-warn', morale: 'is-warn', hero: 'is-info', end: 'is-ok', pop: 'is-warn' };

function todoCard(app, it, i) {
  const art = (it.kind === 'hero' || it.kind === 'morale') && it.hero
    ? heroImg(it.hero, { class: 'todo__hero' })
    : it.icon ? imgEl(it.icon, '', { class: 'todo__icon', 'aria-hidden': 'true' })
      : h('span', { class: 'todo__mark', 'aria-hidden': 'true' });
  const ap = it.kind === 'hero' && it.max > 0
    ? h('span', { class: 'todo__ap', 'aria-hidden': 'true', style: { '--ap': `${Math.round((it.ap / it.max) * 100)}%` } })
    : null;
  const face = it.kind === 'morale' && it.danger ? 'is-bad' : KIND_FACE[it.kind];
  return h('li', { class: 'todo__item' },
    h('button', {
      class: ['todo', 'panel', `todo--${it.kind}`, face, i === 0 ? 'is-next' : null], type: 'button',
      dataset: { todo: it.kind }, onClick: () => it.act(),
      'aria-label': it.go && i !== 0 ? `${it.title}。${subLines(it.sub).join('。')}（${it.go === 'ledger' ? L(app, 'home.t3.goLedger') : t(app, `home.go.${it.go}`)}）` : null,
    },
    h('span', { class: 'todo__art' }, art, ap),
    h('span', { class: 'todo__body' },
      i === 0 ? h('span', { class: 'todo__tag' }, t(app, 'home.next')) : null,
      h('span', { class: 'todo__title' }, it.title),
      // 副題は 1 行ずつ（はみ出す分は見た目だけ省略。文字は全部 DOM に残るので読み上げは全文）
      h('span', { class: 'todo__sub' }, subLines(it.sub).map((x) => h('span', { class: 'todo__line' }, x)))),
    // 行き先は副題に書かず、右端のチップに（どこで何をするかが一目で分かる）
    // 行き先のチップは「次の一手」の 1 枚だけ（短く、アプリの名前だけ）。ほかは矢印だけにして、本文の幅を空ける
    // （長い名前と効き目が 2 行に収まるように。行き先は aria-label に）
    it.go && i === 0 ? h('span', { class: 'todo__chip', 'aria-label': it.go === 'ledger' ? L(app, 'home.t3.goLedger') : t(app, `home.go.${it.go}`) }, L(app, `homeF.go.${it.go}`), h('span', { class: 'todo__go', 'aria-hidden': 'true' }))
      : h('span', { class: 'todo__go', 'aria-hidden': 'true' })));
}

// ------------------------------------------------------------
// 主役ボタン（SPEC-112 §7.5.1・SPEC-114 §7）
// ------------------------------------------------------------

/**
 * ターン終了（ホームのボタンから）。食料が今夜尽きる見込みなら、1 回目は内訳シート（食料）を開くだけ、
 * 2 回目（同じ日）で進む。見込みは積んだ指示のあと（outlook の tonight）。
 */
export function tryEndTurn(app, ol = outlook(app)) {
  if (ol.tonight && app.ui.starveAck !== app.state.day) {
    app.ui.starveAck = app.state.day;
    openLedger(app, 'food');
    return false;
  }
  endTurn();
  return true;
}

/** 主役ボタンの上の 1 行: 「食料 +29/日・士気 平均 58・未指示 0 人」（食料は積んだ内政を足したあと） */
function summaryLine(app, ol, left) {
  const f = ol.foodAfter;
  return h('p', { class: 'home__sum', 'aria-live': 'polite' },
    h('span', null, `${t(app, 'res.food')} `, h('strong', { class: ['num', f > 0 ? 'is-up' : f < 0 ? 'is-down' : null] }, `${signed(f)}${L(app, 'ledger.perDay')}`)),
    h('span', { class: 'home__sum-sep', 'aria-hidden': 'true' }, '・'),
    h('span', null, L(app, 'home.sum.morale'), ' ', h('strong', { class: 'num' }, ol.fc.morale.avg == null ? '-' : String(ol.fc.morale.avg))),
    h('span', { class: 'home__sum-sep', 'aria-hidden': 'true' }, '・'),
    h('span', null, L(app, 'home.sum.left'), ' ', h('strong', { class: ['num', left > 0 ? 'is-left' : null] }, L(app, 'home.sum.people', { n: left }))));
}

/** 今夜の飢えを農作 1 回で避けられるか（本拠地で農作できるヒーローがいて、1 回で今夜を越せる） */
function farmOnceFixes(app, ol) {
  if (!ol.tonight) return false;
  const st = app.state;
  const farmer = mySquads(app).find((s) => orderStatus(app, s) !== 'off' && validate(st, app.db, s, { type: 'domestic', kind: 'farm' }).ok);
  if (!farmer) return false;
  return farmPlan(app, ol, farmer).min === 1;
}

/**
 * 下の操作帯（SPEC-112 §7.5.1: 主役は 1 画面に 1 つ）。
 * - まだやることがある: 主役の金 = 「次の一手」と同じ行き先。ヒーローへの指示は 1 行目に名前、2 行目に「に指示を出す」
 *   （名前が長くても切れない）。ターン終了は枠だけの副ボタン（あと N 人 未指示）
 * - 全員済んだ: ターン終了だけが金で、脈打つ（.is-ready）
 * - 食料が今夜尽きる見込み: ターン終了は「食料が今夜尽きます（全部隊 士気 −15）」（SPEC-114 §7）。
 *   1 回目は内訳、2 回目で進む。農作 1 回で避けられる日は「農作 1 回で避けられます（不足 N）」を添える
 * ギブアップはここに置かない（誤タップの危険）。設定の最下段へ。
 */
function actionBar(app, todo, left, allDone, ol) {
  const next = todo[0];
  const starve = ol.tonight;
  const acked = app.ui.starveAck === app.state.day;
  const v = signed(MORALE_DELTA.starve);
  const short = foodShortTonight(ol);
  const fixable = starve && !acked && farmOnceFixes(app, ol);
  const starveMain = L(app, 'homeF.sum.starve', { v });
  const starveSub = acked ? L(app, 'home.sum.starveGo') : fixable ? L(app, 'homeF.sum.farmOnce', { n: fmt(short) }) : L(app, 'home.sum.starveFirst');
  const sum = summaryLine(app, ol, left);
  if (allDone || !next) {
    return h('div', { class: ['home__actions', 'is-done', starve ? 'is-starve' : null] },
      sum,
      h('div', { class: 'home__btns' },
        h('button', {
          class: ['btn-primary', 'home__end', allDone && !starve ? 'is-ready' : null, starve ? 'is-starve' : null], type: 'button', dataset: { ripple: 'accent', starve: starve ? (acked ? 'ack' : 'warn') : null },
          onClick: () => tryEndTurn(app),
        },
        h('span', { class: 'home__end-main' }, starve ? starveMain : t(app, 'home.endTurn')),
        h('span', { class: 'home__end-sub' }, starve ? starveSub : t(app, 'home.go.end')))));
  }
  const label = next.cta || next.title;
  const named = !!next.ctaName;
  return h('div', { class: ['home__actions', starve ? 'is-starve' : null] },
    sum,
    h('div', { class: 'home__btns' },
      h('button', {
        class: ['btn-secondary', 'home__end', 'is-sub', starve ? 'is-starve' : null], type: 'button', dataset: { starve: starve ? (acked ? 'ack' : 'warn') : null },
        'aria-label': starve ? `${starveMain}。${starveSub}` : null,
        onClick: () => tryEndTurn(app),
      },
      h('span', { class: 'home__end-main' }, starve ? L(app, 'home.sum.starveShort') : t(app, 'home.endTurnShort')),
      starve ? h('span', { class: 'home__end-sub' }, acked ? L(app, 'home.sum.starveGoShort') : L(app, 'homeF.sum.starvePenalty', { v }))
        : left > 0 ? h('span', { class: 'home__end-sub num' }, tf(app, 'home.endLeft', { n: left })) : null),
      h('button', {
        class: ['btn-primary', 'home__next', `home__next--${next.kind}`, named ? 'is-named' : null, !named && Array.from(label).length > 16 ? 'is-long' : null], type: 'button',
        dataset: { ripple: 'accent', next: next.kind }, 'aria-label': `${t(app, 'home.next')}：${label}`, onClick: () => next.act(),
      },
      h('span', { class: 'home__next-tag' }, t(app, 'home.next')),
      named
        ? [h('span', { class: 'home__next-main home__next-name' }, next.ctaName), h('span', { class: 'home__next-sub' }, L(app, 'homeF.next.order'))]
        : h('span', { class: 'home__next-main' }, label))));
}

/** 通知の 1 行（件数・新着。押すと一覧）。トーストはこの行へ吸い込まれる */
function noticesLine(app, notices) {
  const fresh = notices.filter((n) => n.id >= (app.ui.lastBatch || Infinity)).length;
  // まだ 1 件も無ければ出さない（何も言っていない行で場所を取らない。SPEC-114 §0 原則 10）
  if (!notices.length) return null;
  return h('section', { class: 'home__notices is-line', 'aria-labelledby': 'home-notices-title' },
    h('button', { class: 'home__notices-btn', type: 'button', onClick: () => openMorningAll(app, null, true) },
      h('h2', { class: 'section-title home__notices-title', id: 'home-notices-title' }, t(app, 'home.notices'),
        h('span', { class: 'home__notices-count num' }, String(notices.length))),
      h('span', { class: 'home__notices-last' }, fresh ? L(app, 'homeF.notices.fresh', { n: fresh }) : notices[0].text),
      h('span', { class: 'mrow__go', 'aria-hidden': 'true' })));
}

/** ホームに入ってきたとき（最初の描画・別の画面から）だけ、順に出す */
let homeEntered = false;

export const homeView = {
  render(app) {
    const st = app.state;
    const me = st.lands[st.playerLand];
    const def = landDef(app, st.playerLand) || { id: st.playerLand, nameJa: st.playerLand, color: '#c4a35a' };
    const notices = (st.notices || []).slice(-NOTICE_LIST_MAX).reverse();
    const ol = outlook(app);
    const todo = todoList(app, ol);
    const line = homeLine(app, todo, ol);
    const left = mySquads(app).filter((s) => orderStatus(app, s) === 'none').length;
    // 全員の指示が済んだか（やることのカードが 3 件で切れても、ターン終了を主役にする）
    const allDone = !pendingApp() && waitingSquads(app).length === 0;
    const morning = morningCard(app, line.face);
    // 朝の報告が出ている日は、ナビゲーターの舞台の代わりに報告（顔は報告の頭）。報告を畳むと舞台が戻る
    const nv = morning ? null : navi(app, { face: line.face, text: line.text, ctx: `home:${st.day}`, cls: 'home__navi' });
    const sit = situationOf(app);

    const root = h('section', { class: ['home', morning ? 'has-morning' : null], style: { '--land': def.color } },
      // 壁紙（一番奥。自ランドのクリプタイドをぼかして漂わせる）
      h('div', { class: 'home__wall', 'aria-hidden': 'true' },
        imgEl(landAssetPath(def.cryptid), '', { class: 'home__wall-img pixel' })),
      h('header', { class: 'home__land' },
        h('span', { class: 'home__emblem' }, imgEl(landAssetPath(def.icon), def.nameJa || def.name, { class: 'home__land-icon' })),
        h('div', { class: 'home__land-text' },
          h('span', { class: 'home__land-name' }, def.nameJa || def.name),
          landSub(app, me, sit)),
        h('button', { class: 'btn-ghost home__settings', type: 'button', 'aria-label': t(app, 'common.settings') },
          h('span', { class: 'home__gear', 'aria-hidden': 'true' }), h('span', { class: 'home__settings-text' }, t(app, 'common.settings')))),
      // 朝の報告（最上段・畳める。週報は先頭）
      morning,
      h('div', { class: 'home__res' },
        resRow(app, me, ol),
        troopsBar(app, ol)),
      threatRow(app, ol, sit),
      nv ? h('div', { class: 'home__stage' },
        h('div', { class: 'home__bubble-wrap' }, nv.bubble),
        h('div', { class: 'home__navi-clip' }, nv.figure)) : null,
      h('section', { class: 'home__todo panel panel--glass', 'aria-labelledby': 'home-todo-title' },
        h('h2', { class: 'section-title home__todo-title', id: 'home-todo-title' },
          t(app, 'home.todo'), h('span', { class: 'home__todo-day num' }, tf(app, 'home.todoCount', { n: todo.length }))),
        h('ol', { class: 'todo-list' }, todo.map((it, i) => todoCard(app, it, i)))),
      h('nav', { class: 'home__apps panel panel--glass', 'aria-label': t(app, 'home.apps') }, APPS.map((a) => appIcon(app, a))),
      // 通知は 1 行（件数と新着の数だけ。押すと一覧のポップアップ）。入れ子のスクロールは置かない。
      // 朝の報告が出ている日は、報告の「ほか N 件」へ畳む
      morning ? null : noticesLine(app, notices),
      // 親指の帯。主役は 1 つだけ: 未指示がいるあいだは「次の一手」、全員済んだら「ターン終了」（金・脈打つ）
      actionBar(app, todo, left, allDone, ol));
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
    const tv = el.querySelector('.troops-w__val');
    if (tv) fx.rollNumber(tv, Number(tv.dataset.to), { key: 'home.res.troops', format: (n) => Math.floor(n).toLocaleString('ja-JP') });
    const fp = el.querySelector('.home__fp');
    if (fp) fx.rollNumber(fp, Number(fp.dataset.to), { key: 'home.fp' });
    if (el._navi) el._navi.start();
    watchToasts(el);
    // 入ってきたときだけ順に出す（設定を閉じたなどの描き直しでは出さない）
    const entering = !homeEntered || !!document.querySelector('.phone__ghost');
    homeEntered = true;
    if (entering) {
      const m = el.querySelector('.morning');
      if (m) m.classList.add('is-enter');
      if (m) fx.stagger(m.querySelectorAll('.mrow, .mweek__row'), { step: 55, delay: 40, from: 'down', distance: 6 });
      fx.stagger(el.querySelectorAll('.res, .troops-w'), { step: 40, delay: 60, from: 'down', distance: 8 });
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
