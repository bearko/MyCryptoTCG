// chat-view.js — MCH Chat（メッセージアプリ風の指示。SPEC-111 §4・SPEC-112 §4・§7・§7.5.2）
//
// トークの一覧（マインちゃん + 自分のヒーロー）→ トーク（見出し・AP ゲージ・積んだ指示・吹き出し・
// ロスター・主役ボタン・リッチメニュー）。
// ゲームのルールはここに書かない。AP・建てられるか・射程・内政の可否は engine に聞く
// （orders.validate / queue / apMax / apCost、economy.canBuild、hex.within + heroes.rangeOf、turn.targetAt、
//   pathfind.stepCost）。指示のステータス（未指示 / 指示中 / 完了 / 休み）は phone.js の orderStatus。
//
// トークの履歴は app.ui.chat に持つ（state に入れない。リロードで消えてよい）:
//   app.ui.chat = { key, seq, history: { [talkId]: Msg[] }, greeted: { [squadId]: day }, menu, rush, reported,
//                   apSeen: { [squadId]: ap }, chipSeen: { [squadId]: n }, slide, listFresh, shake, call }
//   Msg = { id, who: "hero"|"me"|"sys", text, anim? }   anim は最初に描くときだけ（めくる / 1 文字ずつ / ぽんと出す）
//   talkId は "mai" か squadId。app.ui.chatSquad が開いているトーク（null で一覧）。
//
// 手触り（SPEC-112 §4）:
//   - 送った吹き出しは下から 560ms でめくれるように入り、古いものはその分だけ上へ押し出される
//   - ヒーローの返事は「入力中」の点のあと 1 文字ずつ（fx.typeText）。吹き出しは inline で、文字数に合わせて伸びる
//   - ヒーローの絵は口調（tone）ごとに出方が違う（跳ねる / 傾く / うなずく / 揺れる / ぽんと出る）
//   - AP は区切りのあるゲージ。指示を積むと右から 1 つずつ消える
//   - メニューの各ボタンに AP の消費か、できない理由。できないボタンも押せて、理由と次の一手を返す
//
// 情報（SPEC-114 §4）。数字はすべて engine の関数の値をそのまま出す（ここで計算し直さない）:
//   - 内政のボタンに見込み（economy.previewDomestic の delta / perDay / repeat）と、積んだ回数「×N」。押してもシートは閉じない
//   - 積んだ指示の帯に「このあと 食料 −15 → −16/日」（economy.breakdown の food.net + 積んだ内政の perDay.food）
//   - 見出しの帯に、そのヒーローの士気（morale.moraleOf）と食費（economy.troopFood の部隊の行）
//   - 「1 手戻す」（orders.undoLast。最後の指示だけ外して AP を戻す）。「取り消し」（すべて）も残す
//   - 積んでも何も増えない内政（人口 0 の徴兵・倉庫いっぱいの農作 など）は「できない」扱いにして積まない
//   - 「このあと」は、農作（今夜 1 回きり）と毎日続く変化（徴兵）を分けて「今夜 +97（1 回きり）・明日から −49/日」
//   - 休息は AP を全部使うので、押す前に見込み（兵 +N（人口 0）・士気 +10・AP 全部）を出してから積む
//     （見込みは ledger-view.plannedState の写しに economy.rest をそのまま当てて読む）
//   - 内政・休息の結果は「徴兵：兵 +12」のように単位つきの 1 行で返す

import { h, heroImg, imgEl } from './h.js';
import * as fx from './fx.js';
import { uiText, say } from '../engine/lines.js';
import { queue, validate, clearOrders, undoLast, apMax, apCost, projectedTile } from '../engine/orders.js';
import { canBuild, DOMESTIC_KINDS, previewDomestic, breakdown, troopFood, caps, rest as restOn } from '../engine/economy.js';
import { moraleOf, planNight, MORALE_SHAKEN, MORALE_MAX } from '../engine/morale.js';
import { within, neighbors } from '../engine/hex.js';
import { rangeOf, troopCap, musterCap } from '../engine/heroes.js';
import { plannedState } from './ledger-view.js';
import { stepCost } from '../engine/pathfind.js';
import { targetAt, isShielded, REGROUP_RATE } from '../engine/turn.js';
import { save } from '../state.js';
import { go, render as rerender, pendingApp, endTurn } from '../main.js';
import { orderStatus, setOrderDone, naviPath } from './phone.js';
import { appHead, helpPopup } from './app-kit.js';

const MAI_ID = 'mai';
const MAI_IMAGE = 'Image/Icons/mai_sd.png';
const MAX_HISTORY = 60;
const MAI_NOTICES = 30;
const POLICIES = ['ignore', 'fight', 'ask'];
const MENU = ['move', 'claim', 'build', 'attack', 'domestic', 'rest', 'policy', 'clear'];
/** サブメニューを開くボタン（休息は AP を全部使うので、見込みを見てから積む） */
const SUBMENUS = new Set(['build', 'attack', 'domestic', 'rest', 'policy']);
/** 引数つきのセリフが無い reject.* の理由（ui の chat.reject.* で出す） */
const SPEECH_REJECTS = new Set(['ap', 'home', 'range', 'build']);
/** 口調ごとの、絵の出方 */
const TONE_ENTER = { bushi: 'hop', noble: 'tilt', scholar: 'nod', rogue: 'sway', plain: 'pop' };
/** めくれる時間（SPEC-112 §4: 500〜700ms） */
const FLIP_MS = 560;
/** 下からのシートを閉じる / ロスターを畳む時間 */
const SHEET_OUT_MS = 160;

const t = (app, key) => uiText(app.db, key);
/** 増減の表記（SPEC-114 §8）。マイナスは U+2212 で画面の中を揃える。0 は「±0」 */
const MINUS = '\u2212';
function signed(n) {
  return n > 0 ? `+${n}` : n < 0 ? `${MINUS}${-n}` : '\u00b10';
}
/** 増減の色のクラス（色だけに頼らず、符号は signed で必ず書く） */
function signCls(n) {
  return n > 0 ? 'is-plus' : n < 0 ? 'is-minus' : 'is-zero';
}
/** 文言（無ければ fallback）。{name} などを埋める */
function tf(app, key, vars = {}, fallback) {
  let s = uiText(app.db, key);
  if (s === key && fallback != null) s = fallback;
  return s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? m : String(vars[k])));
}

/** 文言（無ければ chat114.* の同じ名前、それも無ければ fallback） */
function tk(app, key, vars, fallback) {
  const s = uiText(app.db, key);
  return s === key ? tf(app, `chat114.${key}`, vars, fallback) : tf(app, key, vars, fallback);
}

/** この班の文言（data/messages.json の ui の chat114.*） */
function cx(app, key, vars, fallback) {
  return tf(app, `chat114.${key}`, vars, fallback);
}

/** 内政の名前（恩賞は ui の domestic.reward が無ければ chat114.domestic.reward） */
function domName(app, kind) {
  return tk(app, `domestic.${kind}`, {}, kind);
}

// ------------------------------------------------------------
// app.ui.chat（画面だけの状態）
// ------------------------------------------------------------

function chatUi(app) {
  const st = app.state;
  const key = st ? `${st.seed}:${st.playerLand}` : '';
  let c = app.ui.chat;
  // 新しいゲームでは squadId（s1, s2, ...）が使い回されるので、履歴を作り直す
  if (!c || c.key !== key) {
    c = { key, seq: 0, history: {}, greeted: {}, menu: null, rush: false, reported: null, apSeen: {}, chipSeen: {}, slide: 0, listFresh: true, shake: null, call: null };
    app.ui.chat = c;
  }
  return c;
}

function pushMsg(app, talkId, who, text, anim) {
  const c = chatUi(app);
  const list = c.history[talkId] || (c.history[talkId] = []);
  c.seq = (c.seq || 0) + 1;
  list.push({ id: c.seq, who, text, anim: anim === undefined ? (who === 'me' ? 'flip' : who === 'hero' ? 'type' : 'pop') : anim });
  if (list.length > MAX_HISTORY) list.splice(0, list.length - MAX_HISTORY);
}

function heroOf(app, squad) {
  return squad ? app.db.heroes[squad.heroId] || app.db.heroes[String(squad.heroId)] || null : null;
}

function mySquads(app) {
  const st = app.state;
  return Object.values(st.squads || {})
    .filter((s) => s.land === st.playerLand)
    .sort((a, b) => idNum(a.id) - idNum(b.id));
}

function idNum(id) {
  const n = parseInt(String(id).replace(/\D+/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

function canOrder(app) {
  const st = app.state;
  return !!st && !st.ended && st.phase === 'orders' && !app.ui.executing;
}

function landLabel(app, id) {
  if (id === 'enemy') return 'エネミー';
  const l = (app.db.lands || []).find((x) => x.id === id);
  return l ? l.nameJa || l.name : String(id);
}

/** 直前のターンに「指示を仰いだ」部隊（まだ今日の指示を受けていないものだけ） */
function askingSet(app) {
  const st = app.state;
  const out = new Set();
  for (const ev of app.ui.lastEvents || []) {
    if (ev.t !== 'ask') continue;
    const s = st.squads[ev.squad];
    if (s && s.land === st.playerLand && orderStatus(app, s) === 'none') out.add(s.id);
  }
  return out;
}

/** 次に指示するヒーロー（cur の次から一巡。未指示 / 指示中だけ） */
function nextSquad(app, curId) {
  const list = mySquads(app);
  const i = list.findIndex((s) => s.id === curId);
  for (let k = 1; k <= list.length; k++) {
    const s = list[(i + k + list.length) % list.length];
    if (s.id === curId) continue;
    const st = orderStatus(app, s);
    if (st === 'none' || st === 'doing') return s;
  }
  return null;
}

// ------------------------------------------------------------
// 直前のターンの報告（main.js が app.ui.lastEvents を持っていれば使う。無ければ何もしない）
// ------------------------------------------------------------

function absorbReports(app) {
  const st = app.state;
  const c = chatUi(app);
  const evs = app.ui.lastEvents;
  if (!Array.isArray(evs) || c.reported === evs) return;
  c.reported = evs;
  const mine = (id) => {
    const s = st.squads[id];
    return s && s.land === st.playerLand ? s : null;
  };
  for (const ev of evs) {
    let s = null;
    let text = null;
    if (ev.t === 'blocked' && (s = mine(ev.squad))) text = say(app.db, heroOf(app, s), 'report.blocked');
    else if (ev.t === 'routed' && (s = mine(ev.squad))) text = say(app.db, heroOf(app, s), 'report.routed');
    else if (ev.t === 'ask' && (s = mine(ev.squad))) text = say(app.db, heroOf(app, s), 'report.ask');
    else if ((ev.t === 'domestic' || ev.t === 'rest') && (s = mine(ev.squad))) {
      // 内政・休息の結果は、何がいくつ動いたかを単位つきで（ヒーローの口調の「続けるか」は勧めに読めるので使わない）
      pushMsg(app, s.id, 'sys', resultLine(app, s, ev));
      continue;
    } else if (ev.t === 'battle' && (s = mine(ev.attacker))) {
      const target = battleTargetName(app, ev);
      const lost = (ev.followups || []).some((f) => f.t === 'routed' && f.squad === ev.attacker);
      const id = lost ? 'report.lose' : ev.result === 'fort_fallen' ? 'report.fort'
        : ev.ambush && !ev.evaded ? 'report.ambushed_them' : !ev.evaded ? 'report.win' : null;
      if (id) text = say(app.db, heroOf(app, s), id, { target });
    }
    if (s && text) pushMsg(app, s.id, 'hero', text);
  }
}

/** 内政で動く資源（イベントの amount の単位） */
const DOMESTIC_RES = { conscript: 'param.troops', farm: 'res.food', trade: 'res.gum', craft: 'res.mat' };

/**
 * 内政・休息の結果の 1 行（イベントの値をそのまま。「徴兵：兵 +12」「徴兵：人口が足りないので、兵は増えなかった」）。
 * 0 のときの理由は、いまの state で見られるもの（兵が上限か・休息なら定員か）だけ確かめ、残りは人口・倉庫と書く。
 */
function resultLine(app, squad, ev) {
  const hero = heroOf(app, squad);
  const full = hero ? (squad.troops || 0) >= troopCap(hero, squad, app.db) : false;
  if (ev.t === 'rest') {
    const kind = t(app, 'cmd.rest');
    const morale = ev.morale ? ev.morale.delta : 0;
    if (ev.amount > 0) return cx(app, 'fix.report.rest', { kind, n: signed(ev.amount), m: signed(morale) }, '{kind}：兵 {n}・士気 {m}');
    // 休息で戻せるのは定員まで（SPEC-113 §2.1）
    const atMuster = hero ? (squad.troops || 0) >= musterCap(hero, squad, app.db) : false;
    if (atMuster) return cx(app, 'fix.report.restMuster', { kind, m: signed(morale) }, '{kind}：兵は定員まで戻っているので増えなかった（定員を超えるには徴兵）・士気 {m}');
    return cx(app, 'fix.report.restPop', { kind, m: signed(morale) }, '{kind}：人口が 0 なので兵は増えなかった・士気 {m}');
  }
  const kind = domName(app, ev.kind);
  if (ev.kind === 'reward') {
    if (ev.morale === null && !ev.cost) return cx(app, 'fix.report.rewardNg', { kind }, '{kind}：GUM が足りず、払えなかった');
    return cx(app, 'fix.report.reward', { kind, n: signed(ev.morale ? ev.morale.delta : 0), cost: signed(-(ev.cost || 0)) }, '{kind}：士気 {n}（GUM {cost}）');
  }
  const res = DOMESTIC_RES[ev.kind] ? t(app, DOMESTIC_RES[ev.kind]) : '';
  if (ev.amount > 0) return cx(app, 'fix.report.gain', { kind, res, n: signed(ev.amount) }, '{kind}：{res} {n}');
  if (ev.kind === 'conscript') {
    return full ? cx(app, 'fix.report.conscriptFull', { kind }, '{kind}：兵が上限なので、兵は増えなかった')
      : cx(app, 'fix.report.conscriptPop', { kind }, '{kind}：人口が足りないので、兵は増えなかった');
  }
  return cx(app, 'fix.report.storeFull', { kind, res }, '{kind}：倉庫がいっぱいなので、{res}は増えなかった');
}

function battleTargetName(app, ev) {
  const st = app.state;
  if (ev.target === 'home') return `${landLabel(app, ev.defender)}の${t(app, 'chat.toHome')}`;
  if (st.forts[ev.defender]) return st.forts[ev.defender].name;
  const hero = heroOf(app, st.squads[ev.defender]);
  return hero ? hero.name : String(ev.defender);
}

// ------------------------------------------------------------
// 描画
// ------------------------------------------------------------

/** render が作り、mount が流す演出（render と mount は main.js が続けて呼ぶ） */
let pending = null;

export function render(app) {
  const c = chatUi(app);
  absorbReports(app);
  pending = { flips: [], types: [], pops: [], list: false, slide: c.slide || 0, call: null };
  c.slide = 0;
  const el = renderScreen(app, c);
  // 同じ画面の描き直し（メニューを押した など）では、絵のふわっと出る演出をやり直さない（ちらつくので）
  const view = `${app.ui.app}:${app.ui.chatSquad ?? 'list'}`;
  if (el && c.lastView === view) el.classList.add('is-same');
  c.lastView = view;
  return el;
}

function renderScreen(app, c) {
  const id = app.ui.chatSquad;
  if (id === MAI_ID) return renderMai(app);
  const squad = id != null ? app.state.squads[id] : null;
  if (squad && squad.land === app.state.playerLand) return renderTalk(app, squad);
  if (id != null) app.ui.chatSquad = null;
  c.menu = null;
  return renderList(app);
}

/** Chat を離れたら、次に開いたときは新しい画面として扱う */
export function unmount(app) {
  if (app && app.ui && app.ui.chat && app.ui.app !== 'chat') app.ui.chat.lastView = null;
}

function openTalk(app, id, dir = 1) {
  const c = chatUi(app);
  c.menu = null;
  c.rush = false;
  c.slide = dir;
  app.ui.chatSquad = id;
  if (id !== MAI_ID) app.ui.selectedSquad = id;
  rerender();
}

function backToList(app) {
  const c = chatUi(app);
  c.menu = null;
  c.slide = -1;
  c.listFresh = true;
  app.ui.chatSquad = null;
  rerender();
}

// ---------- 指示のステータスの印 ----------

function statusChip(app, kind, extraCls) {
  const label = kind === 'ask' ? tf(app, 'chat.status.ask', {}, '指示を仰いでいる')
    : kind === 'routed' ? t(app, 'chat.routed')
      : t(app, `home.status.${kind}`);
  return h('span', { class: ['chat-status', `chat-status--${kind}`, extraCls], dataset: { status: kind } },
    h('span', { class: 'chat-status__mark', 'aria-hidden': 'true' }), label);
}

/** AP のリング（絵のまわり）。残り / 上限 */
function apRing(node, ap, max, kind) {
  const p = max > 0 ? Math.max(0, Math.min(1, ap / max)) : 0;
  return h('span', { class: ['chat-ring', `chat-ring--${kind}`], style: { '--p': p.toFixed(3) } }, node);
}

// ---------- トークの一覧 ----------

function renderList(app) {
  const st = app.state;
  const c = chatUi(app);
  const notices = st.notices || [];
  const pa = pendingApp();
  const asking = askingSet(app);
  // 指示を仰いでいるヒーロー → 未指示 → 指示中 → 完了 → 休み の順（E: 次に手を付ける人が上）
  const squads = mySquads(app).sort((a, b) => (asking.has(b.id) ? 1 : 0) - (asking.has(a.id) ? 1 : 0)
    || rank(orderStatus(app, a)) - rank(orderStatus(app, b)) || idNum(a.id) - idNum(b.id));
  pending.list = c.listFresh;
  c.listFresh = false;

  // マインちゃん: お知らせ（か選択待ち）があるときだけ一等地。無いときは最下段で小さく
  const hasNews = !!pa || notices.length > 0;
  const lastNotice = notices.length ? notices[notices.length - 1].text : t(app, 'chat.mineEmpty');
  const maiRow = h('li', { class: ['chat-list__mai', hasNews ? null : 'is-quiet'] },
    h('button', { class: ['chat-row', 'chat-row--mai', hasNews ? null : 'chat-row--quiet', pa ? 'is-pending' : null], type: 'button', onClick: () => openTalk(app, MAI_ID) },
      h('span', { class: 'chat-ring chat-ring--mai' }, imgEl(MAI_IMAGE, t(app, 'chat.mine'), { class: 'chat-row__img chat-row__img--mai' })),
      h('span', { class: 'chat-row__main' },
        h('span', { class: 'chat-row__name' }, t(app, 'chat.mine')),
        h('span', { class: 'chat-row__last' }, pa ? t(app, 'chat.pending') : lastNotice)),
      pa ? h('span', { class: 'chat-row__badge', 'aria-label': t(app, 'home.pending') }, '!')
        : h('span', { class: 'chat-row__chev', 'aria-hidden': 'true' })));

  const counts = { none: 0, doing: 0, done: 0, off: 0 };
  const rows = squads.map((s) => {
    const hero = heroOf(app, s);
    const hist = c.history[s.id] || [];
    const last = hist.length ? hist[hist.length - 1].text : summary(app, s) || t(app, 'chat.noLine');
    const max = hero ? apMax(hero, s, app.db) : 0;
    const kind = orderStatus(app, s);
    counts[kind] = (counts[kind] || 0) + 1;
    const ask = asking.has(s.id);
    const chip = ask ? statusChip(app, 'ask') : s.status === 'routed' ? statusChip(app, 'routed') : statusChip(app, kind);
    return h('li', null,
      h('button', {
        class: ['chat-row', `is-${kind}`, ask ? 'is-asking' : null], type: 'button', dataset: { squad: s.id, status: kind },
        onClick: () => openTalk(app, s.id),
      },
      apRing(heroImg(hero, { class: 'chat-row__img', width: 64, height: 64 }), s.ap || 0, max, kind),
      h('span', { class: 'chat-row__main' },
        h('span', { class: 'chat-row__name' }, h('span', { class: 'chat-row__nm' }, hero ? hero.name : s.id), chip),
        h('span', { class: 'chat-row__last' }, last)),
      h('span', { class: 'chat-row__ap num', 'aria-label': `${t(app, 'chat.apLeft')} ${s.ap || 0} / ${max}` },
        h('span', { class: 'chat-row__ap-label' }, t(app, 'param.ap')),
        h('span', { class: 'chat-row__ap-n' }, h('b', null, String(s.ap || 0)), `/${max}`))));
  });

  // 次の一手（E）: 並びの先頭（仰いでいる → 未指示 → 指示中）。全員済みならターン終了
  const target = squads.find((s) => ['none', 'doing'].includes(orderStatus(app, s)));
  let primary = null;
  if (canOrder(app) && squads.length) {
    primary = target
      ? h('button', { class: 'btn-primary chat-primary', type: 'button', dataset: { act: 'talk', squad: target.id }, 'data-ripple': 'accent', onClick: () => openTalk(app, target.id) },
        h('span', { class: 'chat-primary__main' }, tf(app, 'chat.goHero', { name: heroName(app, target) }, '{name} に指示を出す')),
        h('span', { class: 'chat-primary__sub' }, t(app, `home.status.${orderStatus(app, target)}`)),
        h('span', { class: 'chat-primary__arrow', 'aria-hidden': 'true' }))
      : h('button', { class: 'btn-primary chat-primary', type: 'button', dataset: { act: 'end' }, 'data-ripple': 'accent', onClick: () => endTurn() },
        h('span', { class: 'chat-primary__main' }, tf(app, 'chat.allDone', {}, '全員の指示が完了 → ターン終了')),
        h('span', { class: 'chat-primary__arrow', 'aria-hidden': 'true' }));
  }

  // 集計: 見出しの下に 3 つのピル
  const tally = h('ul', { class: 'chat-tally', 'aria-label': tf(app, 'chat.tally', {}, '指示のようす') },
    ['none', 'doing', 'done'].map((k) => h('li', { class: ['chat-tally__item', `chat-tally__item--${k}`, counts[k] ? null : 'is-zero'] },
      h('span', { class: 'chat-status__mark', 'aria-hidden': 'true' }),
      h('span', { class: 'chat-tally__label' }, t(app, `home.status.${k}`)),
      h('b', { class: 'num' }, String(counts[k] || 0)))));

  return h('section', { class: 'app-screen chat chat--list' },
    appHead(app, { title: t(app, 'app.chat'), back: () => go('home'), help: () => openChatHelp(app), cls: 'chat-list-head' }),
    squads.length ? tally : null,
    h('ul', { class: 'chat-list', 'aria-label': t(app, 'chat.list') },
      hasNews ? maiRow : null,
      rows.length ? rows : h('li', { class: 'empty muted' }, t(app, 'chat.noSquads')),
      hasNews ? null : maiRow),
    primary ? h('div', { class: 'chat-dock' }, primary) : null);
}

/** Chat の「?」: 指示のようすの印・AP・メニューの見方 */
function openChatHelp(app) {
  const mark = (k) => h('span', { class: ['chat-status', `chat-status--${k}`] }, h('span', { class: 'chat-status__mark', 'aria-hidden': 'true' }), t(app, `home.status.${k}`));
  helpPopup(app, {
    title: tf(app, 'help.chatTitle', {}, 'Chat の使い方'),
    lead: tf(app, 'help.chatLead', {}, 'ヒーローとのトークで、その日の指示を積みます。上から順に指示して、最後にターン終了です'),
    items: [
      { id: 'none', term: '', tag: mark('none'), text: tf(app, 'help.chat.none', {}, 'まだ指示を 1 つも積んでいないヒーロー') },
      { id: 'doing', term: '', tag: mark('doing'), text: tf(app, 'help.chat.doing', {}, '指示を積んでいて、AP がまだ残っているヒーロー') },
      { id: 'done', term: '', tag: mark('done'), text: tf(app, 'help.chat.done', {}, '「指示を終える」を押したか、AP を使い切ったヒーロー。トークを開けば指示を足せます') },
      { id: 'off', term: '', tag: mark('off'), text: tf(app, 'help.chat.off', {}, '敗走などで今日は動けないヒーロー') },
      { id: 'ap', term: 'AP', text: tf(app, 'help.chat.ap', {}, '1 日に使える行動の量。指示を積むと減り、翌日に戻ります') },
      { id: 'menu', term: tf(app, 'help.chat.menuTerm', {}, 'メニュー'), text: tf(app, 'help.chat.menu', {}, '金のピルは使う AP。黄色の点が付いたボタンは今はできない指示で、押すと理由と次の一手が出ます') },
      { id: 'domestic', term: t(app, 'cmd.domestic'), text: cx(app, 'help.domestic', {}, '各ボタンに、押したら何がどれだけ動くかの見込みと、あと何回積めるかが出ます。押してもメニューは閉じないので、続けて積めます') },
      { id: 'after', term: cx(app, 'after', {}, 'このあと'), text: cx(app, 'fix.help.after', {}, '積んだ内政を足したあとの食料の増減（ランド全体）。農作は今夜 1 回だけ入る量なので「今夜 +N（1 回きり）」、毎日続く分は「明日から −N/日」と分けて出します') },
      { id: 'morale', term: cx(app, 'morale', {}, '士気'), text: cx(app, 'help.morale', {}, '0〜100。高いほど戦闘で強い。20 未満は「動揺」、0 になると兵が逃げ始めます。恩賞と休息で上がります') },
      { id: 'food', term: cx(app, 'troopFood', {}, '食費'), text: cx(app, 'help.food', {}, 'そのヒーローの兵が 1 日に食べる食料。兵が増えるほど増えます') },
      { id: 'muster', term: cx(app, 'muster', {}, '定員'), text: cx(app, 'help.muster', { regroup: Math.round(REGROUP_RATE * 100) }, '部隊が集めた兵の数。戦いで減った兵は、夜の回復・休息などで定員まで戻ります。定員を超えて増やせるのは徴兵だけです') },
      { id: 'undo', term: cx(app, 'undo', {}, '1 手戻す'), text: cx(app, 'help.undo', {}, '最後に積んだ指示を 1 つだけ外し、AP を戻します。全部やめるときはメニューの「取り消し」') },
    ],
  });
}

function rank(kind) {
  return kind === 'none' ? 0 : kind === 'doing' ? 1 : kind === 'done' ? 2 : 3;
}

function heroName(app, squad) {
  const hero = heroOf(app, squad);
  return hero ? hero.name : String(squad.id);
}

// ---------- マインちゃん（ホームの通知と同じ内容） ----------

function renderMai(app) {
  const st = app.state;
  const notices = (st.notices || []).slice(-MAI_NOTICES);
  const pa = pendingApp();
  const items = [];
  items.push(bubbleMai(app, t(app, 'chat.mineLead')));
  if (!notices.length) items.push(bubbleMai(app, t(app, 'chat.mineEmpty')));
  let lastDay = null;
  for (const n of notices) {
    if (n.day !== lastDay) {
      items.push(h('li', { class: 'chat-day num' }, `${t(app, 'status.day')} ${n.day}`));
      lastDay = n.day;
    }
    // Chat 宛ての通知は、ここで読めているのでリンクにしない
    const target = n.app === 'chat' ? null : n.app || (n.tile != null ? 'map' : null);
    const body = target
      ? h('button', { class: 'chat-bubble__link', type: 'button', onClick: () => go(target, n.tile != null ? { tile: n.tile } : {}) },
        n.text, h('span', { class: 'chat-bubble__app' }, t(app, `app.${target}`).replace(/^MCH /, '')))
      : n.text;
    items.push(bubbleMai(app, body));
  }
  if (pa) {
    items.push(bubbleMai(app,
      h('button', { class: 'chat-bubble__link', type: 'button', onClick: () => go(pa) },
        t(app, 'chat.pending'), h('span', { class: 'chat-bubble__app' }, t(app, `app.${pa}`).replace(/^MCH /, '')))));
  }
  pending.maiEnter = true;
  return h('section', { class: 'chat chat--talk chat--mai' },
    talkHead(app, imgEl(MAI_IMAGE, t(app, 'chat.mine'), { class: 'chat-head__img chat-head__img--mai' }), t(app, 'chat.mine'), null),
    room(imgEl(naviPath('normal'), '', { class: 'chat-room__img chat-room__img--navi', 'aria-hidden': 'true' }),
      h('ol', { class: 'chat-log', 'aria-live': 'polite' }, items)));
}

function bubbleMai(app, content) {
  return h('li', { class: 'chat-msg chat-msg--them' },
    imgEl(MAI_IMAGE, t(app, 'chat.mine'), { class: 'chat-msg__img chat-msg__img--mai' }),
    h('div', { class: 'chat-bubble' }, content));
}

// ---------- ヒーローとのトーク ----------

function renderTalk(app, squad) {
  const st = app.state;
  const c = chatUi(app);
  const hero = heroOf(app, squad);
  // greet.morning はトークを開いたときに 1 日 1 回
  if (c.greeted[squad.id] !== st.day && canOrder(app)) {
    c.greeted[squad.id] = st.day;
    pushMsg(app, squad.id, 'hero', say(app.db, hero, 'greet.morning', { name: hero ? hero.name : '', day: st.day }));
  }
  const hist = c.history[squad.id] || [];
  const log = h('ol', { class: 'chat-log', 'aria-live': 'polite' },
    hist.map((m) => {
      const anim = m.anim;
      m.anim = null; // 演出は最初に描くときだけ
      if (m.who === 'me') return bubbleMe(m.text, anim);
      if (m.who === 'sys') return sysLine(m.text, anim);
      return bubbleHero(app, hero, m.text, anim);
    }));

  const orderable = canOrder(app);
  const sheet = orderable ? submenu(app, squad) : null;
  // シートが開いた / 閉じたときだけ、ロスターを畳む / 広げる動きを付ける（描き直しのたびには動かさない）
  const sheetNow = !!sheet;
  const fold = c.sheetWas == null || c.sheetWas === sheetNow ? null : sheetNow ? 'fold' : 'unfold';
  c.sheetWas = sheetNow;
  // 同じシートを開いたままの描き直し（内政を続けて積んだ など）では、下から出る動きをやり直さない
  const sheetKey = sheet ? `${squad.id}:${c.menu}` : null;
  if (sheet && c.sheetKey === sheetKey) sheet.classList.add('is-still');
  c.sheetKey = sheetKey;
  return h('section', { class: ['chat', 'chat--talk', sheet ? 'has-sheet' : null], dataset: { squad: squad.id, status: orderStatus(app, squad) } },
    talkHead(app, apRingHead(app, squad, hero), hero ? hero.name : squad.id, headInfo(app, squad, hero), headStats(app, squad)),
    apGauge(app, squad, hero),
    queuedStrip(app, squad),
    afterStrip(app),
    // 会話の欄の奥に、その人の絵を大きく（空白が「その人の部屋」になる）
    room(heroImg(hero, { class: 'chat-room__img', width: 160, height: 160, 'aria-hidden': 'true' }), log),
    sheet,
    orderable ? dock(app, squad, { folded: sheetNow, fold }) : null,
    orderable ? richMenu(app, squad) : h('p', { class: 'chat-locked muted' }, t(app, 'chat.locked')));
}

/** 会話の欄（奥に大きな絵を敷く） */
function room(art, log) {
  if (art) art.setAttribute('alt', '');
  return h('div', { class: 'chat-room' },
    h('div', { class: 'chat-room__art', 'aria-hidden': 'true' }, art),
    log);
}

function apRingHead(app, squad, hero) {
  const max = hero ? apMax(hero, squad, app.db) : 0;
  const ring = apRing(heroImg(hero, { class: 'chat-head__img', width: 40, height: 40 }), squad.ap || 0, max, orderStatus(app, squad));
  ring.classList.add('chat-ring--head');
  return ring;
}

/** 見出しの右: 指示のステータス（完了のときは押すと取り消せる） */
function headInfo(app, squad) {
  const kind = orderStatus(app, squad);
  const marked = app.ui.orderDone && app.ui.orderDone[squad.id] === app.state.day;
  const chip = statusChip(app, kind, 'chat-head__status');
  if (kind === 'done' && marked && canOrder(app)) {
    return h('button', {
      class: 'chat-head__undo', type: 'button', title: tf(app, 'chat.undoDone', {}, '完了を取り消す'),
      'aria-label': `${t(app, 'home.status.done')}・${tf(app, 'chat.undoDone', {}, '完了を取り消す')}`,
      onClick: () => { setOrderDone(app, squad.id, false); rerender(); },
    }, chip);
  }
  return chip;
}

export function mount(app, el) {
  const p = pending || { flips: [], types: [], pops: [] };
  pending = null;
  if (!el) return;
  const reduce = fx.reducedMotion();
  // 吹き出しは下に積むので、いちばん下を見せる
  const log = el.querySelector('.chat-log');
  if (log) log.scrollTop = log.scrollHeight;
  // 積んだ指示のチップは右に足していくので、いちばん新しいもの（右端）を見せる
  const chips = el.querySelector('.chat-queue__list');
  if (chips) chips.scrollLeft = chips.scrollWidth;
  // トークどうし / 一覧との行き来は横にすべる（アプリの切り替えは main.js が受け持つ）
  if (p.slide && !reduce) fx.slideIn(el, p.slide, { distance: 36 });
  if (p.list) fx.stagger(el.querySelectorAll('.chat-list > li'), { from: 'up', step: 55, delay: p.slide ? 60 : 120, distance: 18 });
  if (p.maiEnter && log && !reduce) fx.stagger(Array.from(log.children).slice(-4), { from: 'up', step: 60, distance: 10 });
  if (log) playLog(log, p, reduce);
  // 「このあと」の数字は、前の値から転がす（増えたら緑・減ったら赤で一瞬光る。動きを減らすときはすぐ）
  if (p.after) {
    const n = el.querySelector('.chat-after__n');
    if (n) fx.rollNumber(n, p.after.to, { from: p.after.from, format: (v) => signed(Math.round(v)) });
  }
  // シートの外（会話の欄・AP・積んだ指示・見出しの空き）をタップしたら閉じる
  const talk = el.classList && el.classList.contains('chat--talk') ? el : null;
  if (talk && talk.classList.contains('has-sheet')) {
    talk.addEventListener('click', (e) => {
      const tg = e.target;
      if (!tg || !tg.closest || tg.closest('.chat-sub, .chat-menu, .chat-dock, button, a')) return;
      closeSheet(app);
    });
  }
}

/** 下からのシートを沈めて閉じる（動きを減らすときはすぐ） */
function closeSheet(app) {
  if (!app) return;
  const c = chatUi(app);
  if (!c.menu || c.closing) return;
  const sheet = typeof document !== 'undefined' ? document.querySelector('.chat--talk .chat-sub') : null;
  const done = () => { c.closing = false; c.menu = null; rerender(); };
  if (!sheet || fx.reducedMotion() || !sheet.animate) { done(); return; }
  c.closing = true;
  sheet.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(24px)' }],
    { duration: SHEET_OUT_MS, easing: 'cubic-bezier(.55, 0, .75, .2)', fill: 'forwards' })
    .finished.then(done, done);
}

/** 新しい吹き出しの演出（めくる → 入力中 → 1 文字ずつ）を順に流す */
function playLog(log, p, reduce) {
  const items = [...p.flips, ...p.types, ...p.pops];
  if (!items.length) return;
  // 古い吹き出しは、新しいものが入った分だけ上へ押し出される（スクロールしきっている分だけ動かす）
  if (!reduce && log.animate) {
    const added = items.reduce((sum, li) => sum + li.offsetHeight + 8, 0);
    const over = Math.max(0, log.scrollHeight - log.clientHeight);
    const shift = over - Math.max(0, over - added);
    if (shift > 0) {
      const fresh = new Set(items);
      for (const li of log.children) {
        if (fresh.has(li)) continue;
        li.animate([{ transform: `translateY(${shift}px)` }, { transform: 'none' }], { duration: FLIP_MS, easing: 'cubic-bezier(.16, 1, .3, 1)' });
      }
    }
  }
  let at = 0;
  for (const li of p.flips) {
    if (!reduce && li.animate) {
      li.animate([
        { transform: 'perspective(640px) translateY(34px) rotateX(-78deg)', opacity: 0, filter: 'brightness(1.8)' },
        { transform: 'perspective(640px) translateY(-3px) rotateX(6deg)', opacity: 1, offset: 0.62 },
        { transform: 'none', opacity: 1, filter: 'none' },
      ], { duration: FLIP_MS, easing: 'cubic-bezier(.2, .8, .25, 1)', fill: 'backwards', delay: at });
    }
    at += 90;
  }
  for (const li of p.pops) {
    if (!reduce && li.animate) li.animate([{ opacity: 0, transform: 'scale(.86)' }, { opacity: 1, transform: 'none' }], { duration: 260, delay: at, easing: 'cubic-bezier(.34, 1.56, .64, 1)', fill: 'backwards' });
  }
  // ヒーローの返事: めくれ終わる少し前に「入力中」、そのあと 1 文字ずつ
  let chain = Promise.resolve();
  const startAt = p.flips.length ? Math.round(FLIP_MS * 0.6) : 60;
  p.types.forEach((li, i) => {
    chain = chain.then(() => typeOne(log, li, i === 0 ? startAt : 120, reduce));
  });
}

function typeOne(log, li, delay, reduce) {
  return new Promise((resolve) => {
    const bubble = li.querySelector('.chat-bubble');
    const text = li.dataset.text || '';
    if (!bubble) { resolve(); return; }
    const finish = () => {
      li.classList.remove('is-waiting', 'is-typing');
      resolve();
    };
    if (reduce) {
      bubble.textContent = text;
      finish();
      return;
    }
    setTimeout(() => {
      if (!li.isConnected) { resolve(); return; }
      li.classList.remove('is-waiting');
      li.classList.add('is-entering');
      li.animate?.([{ opacity: 0, transform: 'translateY(10px) scale(.92)' }, { opacity: 1, transform: 'none' }],
        { duration: 240, easing: 'cubic-bezier(.34, 1.56, .64, 1)' });
      keepBottom(log);
      // 入力中の点（短く）
      const dotsMs = Math.min(720, 380 + text.length * 6);
      setTimeout(() => {
        if (!li.isConnected) { resolve(); return; }
        const span = document.createElement('span');
        span.className = 'chat-bubble__text';
        bubble.textContent = '';
        bubble.appendChild(span);
        li.classList.add('is-typing');
        const ctl = fx.typeText(span, text, { cps: 42, skipOn: li, caret: true });
        const follow = setInterval(() => keepBottom(log), 120);
        ctl.done.then(() => { clearInterval(follow); keepBottom(log); finish(); });
      }, dotsMs);
    }, delay);
  });
}

/** 1 文字ずつ伸びる間、いちばん下を見せ続ける（ユーザーが上へ読みに行っていたら動かさない） */
function keepBottom(log) {
  if (!log.isConnected) return;
  const gap = log.scrollHeight - log.clientHeight - log.scrollTop;
  if (gap < 80) log.scrollTop = log.scrollHeight;
}

function talkHead(app, imgNode, name, extra, stats) {
  return h('header', { class: ['chat-head', stats ? 'has-stats' : null] },
    h('button', { class: 'btn-ghost chat-head__back', type: 'button', 'aria-label': t(app, 'chat.back'), onClick: () => backToList(app) },
      h('span', { class: 'chat-head__chev', 'aria-hidden': 'true' }), t(app, 'chat.title')),
    imgNode,
    h('span', { class: 'chat-head__name' }, name),
    extra,
    stats || null);
}

/**
 * 見出しの帯の 2 行目（SPEC-114 §4）: そのヒーローの士気（ゲージと数字。20 未満は「動揺」、0 は「逃走中 今夜 −N 人」）と、
 * 兵の食費（economy.troopFood の、その部隊の行）。色だけに頼らず、数字と言葉を必ず添える。
 */
function headStats(app, squad) {
  const st = app.state;
  const m = moraleOf(squad);
  const routed = squad.status === 'routed';
  const level = routed ? 'off' : m <= 0 ? 'zero' : m < MORALE_SHAKEN ? 'shaken' : m >= 60 ? 'high' : 'mid';
  // 士気 0 はもう逃げている。今夜逃げる人数は Drive のヒーローのカードと同じ見方（積んだ指示のあとの写しを planNight にかける）
  const des = level === 'zero' ? desertTonight(app, squad) : 0;
  const word = level === 'zero'
    ? (des > 0 ? cx(app, 'fix.desertTonight', { n: des }, '逃走中 今夜 −{n} 人') : cx(app, 'fix.zeroHold', {}, '今夜は逃げない'))
    : level === 'shaken' ? cx(app, 'morale.shaken', {}, '動揺') : null;
  const row = troopFood(st, app.db, squad.land).rows.find((r) => r.squad === squad.id);
  const food = row ? row.value : 0;
  const moraleLabel = cx(app, 'morale', {}, '士気');
  const foodLabel = cx(app, 'troopFood', {}, '食費');
  // 兵 / 定員（夜の回復・休息で戻せるのは定員まで。上限は徴兵でしか届かない。SPEC-113 §2.1）
  const hero = heroOf(app, squad);
  const troops = Math.max(0, squad.troops || 0);
  const muster = hero ? musterCap(hero, squad, app.db) : troops;
  const cap = hero ? troopCap(hero, squad, app.db) : troops;
  const perDay = (n) => cx(app, 'perDay', { n }, '{n}/日');
  return h('span', { class: 'chat-head__stats' },
    h('span', {
      class: ['chat-mor', `chat-mor--${level}`], role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(m),
      'aria-label': `${moraleLabel} ${m}${word ? `（${word}）` : ''}`, dataset: { morale: m },
    },
    h('span', { class: 'chat-mor__label', 'aria-hidden': 'true' }, moraleLabel),
    h('span', { class: 'chat-mor__bar', 'aria-hidden': 'true' }, h('i', { style: { '--v': (Math.max(0, Math.min(100, m)) / 100).toFixed(2) } })),
    h('b', { class: 'chat-mor__n num', 'aria-hidden': 'true' }, String(m)),
    word ? h('span', { class: ['chat-mor__word', level === 'zero' && des <= 0 ? 'is-hold' : null], 'aria-hidden': 'true' }, word) : null),
    h('span', {
      class: ['chat-head__troops', 'num', troops < muster ? 'is-low' : null], dataset: { troops, muster },
      title: cx(app, 'troopsAria', { n: troops, muster, cap }, '兵 {n}、定員 {muster}（上限 {cap}）'),
    }, cx(app, 'troopsOf', { n: troops, muster }, '兵 {n}/{muster}')),
    h('span', { class: ['chat-head__food', 'num', food > 0 ? 'is-minus' : 'is-zero'], dataset: { food } },
      h('span', { class: 'chat-head__food-label' }, foodLabel), ` ${perDay(signed(-food))}`));
}

/**
 * その部隊から今夜逃げる兵の数（morale.planNight の desert）。積んだ指示のあとの写し（ledger-view.plannedState）で、
 * 飢えるかは economy.forecast と同じ決め方（在庫 + 差し引き < 0）。Drive・Ledger と同じ見方。
 */
function desertTonight(app, squad) {
  const me = squad.land;
  const sim = plannedState(app, me);
  const b = breakdown(sim, app.db, me).food;
  const row = planNight(sim, app.db, me, b.stock + b.net < 0, 0).desert.find((d) => d.squad === squad.id);
  return row ? row.amount : 0;
}

function bubbleHero(app, hero, text, anim) {
  const tone = (hero && hero.tone) || 'plain';
  const avatar = heroImg(hero, { class: ['chat-msg__img', `chat-msg__img--${TONE_ENTER[tone] || 'pop'}`].join(' '), width: 32, height: 32 });
  if (anim === 'type' && typeof text === 'string' && text.length > 1) {
    // 入力中の点を出しておき、mount で 1 文字ずつに差し替える（読み上げには最初から全文）
    const li = h('li', { class: 'chat-msg chat-msg--them is-new is-waiting', dataset: { text } },
      avatar,
      h('div', { class: 'chat-bubble' },
        h('span', { class: 'sr-only' }, text),
        h('span', { class: 'chat-typing', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'))));
    if (pending) pending.types.push(li);
    return li;
  }
  return h('li', { class: 'chat-msg chat-msg--them' }, avatar, h('div', { class: 'chat-bubble' }, text));
}

function bubbleMe(text, anim) {
  const li = h('li', { class: ['chat-msg', 'chat-msg--me', anim ? 'is-new' : null] }, h('div', { class: 'chat-bubble chat-bubble--me' }, text));
  if (anim && pending) pending.flips.push(li);
  return li;
}

function sysLine(text, anim) {
  const li = h('li', { class: 'chat-sys' }, text);
  if (anim && pending) pending.pops.push(li);
  return li;
}

// ---------- AP ゲージ（区切りあり。積むと右から 1 つずつ消える） ----------

function apGauge(app, squad, hero) {
  const c = chatUi(app);
  const max = hero ? apMax(hero, squad, app.db) : 0;
  const ap = Math.max(0, squad.ap || 0);
  const prev = c.apSeen[squad.id];
  c.apSeen[squad.id] = ap;
  if (max <= 0) {
    return h('div', { class: 'chat-ap chat-ap--off' },
      h('span', { class: 'chat-ap__label' }, t(app, 'param.ap')),
      h('span', { class: 'chat-ap__off muted' }, t(app, 'home.status.off')));
  }
  const cells = [];
  const segs = Math.max(max, ap);
  for (let i = 0; i < segs; i++) {
    const on = i < ap;
    const cls = ['chat-ap__seg', on ? 'is-on' : null];
    let delay = 0;
    // 減った分: 右（大きい番号）から順に消える。増えた分: 左から順に灯る
    if (prev != null && prev > ap && i >= ap && i < prev) { cls.push('is-drain'); delay = (prev - 1 - i) * 70; }
    if (prev != null && prev < ap && i >= prev && i < ap) { cls.push('is-fill'); delay = (i - prev) * 50; }
    cells.push(h('span', { class: cls, style: delay ? { '--d': `${delay}ms` } : null }));
  }
  const rolling = prev != null && prev !== ap;
  const num = h('b', { class: 'chat-ap__n num' }, String(rolling ? prev : ap));
  // 前回の値から転がす（描き直しで要素が作り直されるので、前回の値は apSeen で覚えている）
  if (rolling) rollAp(num, prev, ap);
  return h('div', { class: ['chat-ap', ap === 0 ? 'is-empty' : null], role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': String(max), 'aria-valuenow': String(ap),
    'aria-label': `${t(app, 'chat.apLeft')} ${ap} / ${max}` },
  h('span', { class: 'chat-ap__label' }, t(app, 'chat.apLeft')),
  h('span', { class: 'chat-ap__bar', 'aria-hidden': 'true', style: { '--n': segs } }, cells),
  h('span', { class: 'chat-ap__num' }, num, h('span', { class: 'chat-ap__max' }, `/${max}`)));
}

/**
 * AP の数を前回の値から転がす（減ったら赤・増えたら緑で一瞬光る。見た目は fx.rollNumber と同じクラス）。
 * 進み具合は 0〜1 に収める（rAF の時刻が始めた時刻より前のことがあり、そのままだと最初のコマが行き過ぎる）。
 */
function rollAp(el, from, to) {
  el.classList.add('fx-roll', to > from ? 'is-up' : 'is-down');
  if (fx.reducedMotion() || typeof requestAnimationFrame === 'undefined') { el.textContent = String(to); return; }
  const ms = Math.min(700, 320 + Math.abs(to - from) * 40);
  const t0 = performance.now();
  const tick = (now) => {
    if (!el.isConnected && now - t0 > 50) return;
    const k = Math.min(1, Math.max(0, (now - t0) / ms));
    const e = 1 - Math.pow(1 - k, 3);
    el.textContent = String(Math.round(from + (to - from) * e));
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ---------- 積んだ指示（チップ） ----------

function orderLabel(app, squad, o) {
  switch (o.type) {
    case 'move': return `${t(app, 'cmd.move')} ${o.path ? o.path.length : 0}`;
    case 'build': return `${t(app, 'cmd.build')} ${t(app, `facility.${o.kind}`)}`;
    case 'attack': return `${t(app, 'cmd.attack')} ${targetLabel(app, squad, o.target)}`;
    case 'domestic': return `${t(app, 'cmd.domestic')} ${domName(app, o.kind)}`;
    default: return t(app, `cmd.${o.type}`);
  }
}

function summary(app, squad) {
  return (squad.orders || []).map((o) => orderLabel(app, squad, o)).join(' → ');
}

function queuedStrip(app, squad) {
  const c = chatUi(app);
  const orders = squad.orders || [];
  const seen = c.chipSeen[squad.id];
  c.chipSeen[squad.id] = orders.length;
  const last = orders[orders.length - 1];
  const back = last && typeof last.ap === 'number' ? last.ap : 0;
  // 「1 手戻す」: 最後の指示だけ外す（orders.undoLast）。指示が無いとき・指示を出せないときは出さない
  const undo = orders.length && canOrder(app)
    ? h('button', {
      class: 'chat-undo', type: 'button', dataset: { act: 'undo' },
      'aria-label': cx(app, 'undoAria', { order: orderLabel(app, squad, last), n: back }, '最後の指示（{order}）を外す・AP +{n}'),
      onClick: () => doUndo(app, squad),
    },
    h('span', { class: 'chat-undo__icon', 'aria-hidden': 'true' }),
    h('span', { class: 'chat-undo__text' }, cx(app, 'undo', {}, '1 手戻す')),
    back ? h('span', { class: 'chat-undo__ap num', 'aria-hidden': 'true' }, `AP +${back}`) : null)
    : null;
  return h('div', { class: ['chat-queue', undo ? 'has-undo' : null] },
    h('span', { class: 'chat-queue__label' }, t(app, 'chat.queued')),
    orders.length
      ? h('ol', { class: 'chat-queue__list' }, chipGroups(orders).map((g) => h('li', {
        class: ['chat-queue__item', seen != null && g.last >= seen ? 'is-new' : null], dataset: { type: g.order.type, n: g.n },
        'aria-label': `${orderLabel(app, squad, g.order)}${g.n > 1 ? ` ${cx(app, 'count', { n: g.n }, '×{n}')}` : ''}・AP ${signed(-g.ap)}`,
      },
      h('span', { class: `chat-menu__icon chat-menu__icon--${g.order.type} chat-queue__icon`, 'aria-hidden': 'true' }),
      // 内政は記号が「内政」を表すので、種類の名前だけ。続けて積んだ同じ内政は「×N」にまとめる
      h('span', { class: 'chat-queue__text', 'aria-hidden': 'true' }, g.order.type === 'domestic' ? domName(app, g.order.kind) : orderLabel(app, squad, g.order)),
      g.n > 1 ? h('span', { class: 'chat-queue__n num', 'aria-hidden': 'true' }, cx(app, 'count', { n: g.n }, '×{n}')) : null,
      g.hasAp ? h('span', { class: 'chat-queue__ap num', 'aria-hidden': 'true' }, signed(-g.ap)) : null)))
      : h('span', { class: 'chat-queue__none muted' }, t(app, 'chat.noOrders')),
    undo);
}

/** 積んだ指示のチップ: 続けて積んだ同じ内政を 1 枚にまとめる（{ order, n, ap, hasAp, last }。last は最後の指示の番号） */
function chipGroups(orders) {
  const out = [];
  orders.forEach((o, i) => {
    const prev = out[out.length - 1];
    const hasAp = typeof o.ap === 'number';
    if (prev && o.type === 'domestic' && prev.order.type === 'domestic' && prev.order.kind === o.kind) {
      prev.n += 1;
      prev.ap += hasAp ? o.ap : 0;
      prev.hasAp = prev.hasAp || hasAp;
      prev.last = i;
    } else {
      out.push({ order: o, n: 1, ap: hasAp ? o.ap : 0, hasAp, last: i });
    }
  });
  return out;
}

/**
 * 積んである内政で、今夜の食料の差し引きがいくつ動くか（SPEC-114 §4）。
 * 足すのは engine の previewDomestic(...).perDay.food だけ（SPEC-113 §6.3。ここで計算し直さない）。
 * previewDomestic は「すでに積んである指示のあと」のもう 1 回ぶんを返すので、自分のランドの指示を外した写しに、
 * 部隊の並び順 → 各部隊の積んだ順（engine の数え方と同じ順）で積み直しながら、その直前の見込みを足していく。
 * 積んだときに値を控えておく形にしないのは、Map で積んだ指示・1 手戻す・再読み込みで食い違うため。
 * 農作の perDay.food はその夜に 1 回だけ入る量（翌日は元に戻る）なので once に、徴兵など毎日続く変化は daily に分けて足す。
 * @returns {{food:number, once:number, daily:number, count:number}} food = once + daily。count は数えた内政の数
 */
function queuedFood(app) {
  const st = app.state;
  const land = st.playerLand;
  const squads = {};
  const mine = [];
  for (const [id, s] of Object.entries(st.squads || {})) {
    if (s.land !== land) { squads[id] = s; continue; }
    let back = 0;
    for (const o of s.orders || []) back += typeof o.ap === 'number' ? o.ap : 0;
    const copy = { ...s, orders: [], ap: (s.ap || 0) + back };
    squads[id] = copy;
    mine.push([s, copy]);
  }
  const sim = { ...st, squads };
  let once = 0;
  let daily = 0;
  let count = 0;
  for (const [s, copy] of mine) {
    for (const o of s.orders || []) {
      if (o.type === 'domestic') {
        const v = previewDomestic(sim, app.db, copy, o.kind).perDay.food;
        if (o.kind === 'farm') once += v;
        else daily += v;
        count += 1;
      }
      copy.orders.push(o);
      copy.ap -= typeof o.ap === 'number' ? o.ap : 0;
    }
  }
  return { food: once + daily, once, daily, count };
}

/**
 * 積んだ指示の帯の下: 「このあと 食料 −15 → +29/日」（SPEC-114 §4）。
 * 左は今夜の見込み（economy.breakdown の food.net。積んだ指示を含まない）、右はそこに積んだ内政の perDay を足した値。
 * 内政が今夜の食料を動かさないときは「食料 −15/日」だけ。ランド全体の値（食料は全部隊で 1 つ）。
 */
function afterStrip(app) {
  const st = app.state;
  if (!st.lands[st.playerLand]) return null;
  const c = chatUi(app);
  const now = breakdown(st, app.db, st.playerLand).food.net;
  const q = queuedFood(app);
  // 農作は今夜 1 回だけ入る（once）。毎日続くのは daily だけなので、「明日から」はそちらで出す
  const daily = now + q.daily;
  const after = now + q.food;
  const changed = q.daily !== 0;
  const perDay = (n) => cx(app, 'perDay', { n }, '{n}/日');
  const prev = c.afterSeen;
  c.afterSeen = daily;
  pending.after = prev != null && prev !== daily ? { from: prev, to: daily } : null;
  const label = cx(app, 'after', {}, 'このあと');
  const food = t(app, 'res.food');
  const dailyVal = h('b', { class: ['chat-after__val', 'num', signCls(daily)], 'aria-hidden': 'true' },
    h('span', { class: 'chat-after__n' }, signed(daily)), perDay('').trim());
  if (q.once) {
    // 「今夜 +97（1 回きり）・明日から −49/日」: 増えたはずが翌朝に減って見える、を先に言っておく
    const aria = cx(app, 'fix.afterOnceAria', { label, res: food, once: signed(q.once), daily: perDay(signed(daily)) },
      '{label} {res}：今夜 農作で {once}（1 回きり）、明日から {daily}');
    return h('div', { class: ['chat-after', 'is-changed', 'has-once', signCls(daily)], dataset: { now, after, daily, once: q.once }, 'aria-label': aria },
      h('span', { class: 'chat-after__label', 'aria-hidden': 'true' }, label),
      h('span', { class: 'chat-after__res', 'aria-hidden': 'true' }, food),
      h('span', { class: 'chat-after__once', 'aria-hidden': 'true' },
        h('span', { class: 'chat-after__k' }, cx(app, 'fix.tonight', {}, '今夜')),
        h('b', { class: ['num', signCls(q.once)] }, signed(q.once)),
        h('span', { class: 'chat-after__tag' }, cx(app, 'fix.once', {}, '1 回きり'))),
      h('span', { class: 'chat-after__daily', 'aria-hidden': 'true' },
        h('span', { class: 'chat-after__k' }, cx(app, 'fix.fromTomorrow', {}, '明日から')),
        dailyVal));
  }
  return h('div', { class: ['chat-after', changed ? 'is-changed' : null, signCls(daily)], dataset: { now, after, daily, once: 0 },
    'aria-label': `${label} ${food} ${changed ? `${perDay(signed(now))} → ` : ''}${perDay(signed(daily))}` },
  h('span', { class: 'chat-after__label', 'aria-hidden': 'true' }, label),
  h('span', { class: 'chat-after__res', 'aria-hidden': 'true' }, food),
  changed ? h('span', { class: ['chat-after__now', 'num', signCls(now)], 'aria-hidden': 'true' }, perDay(signed(now))) : null,
  changed ? h('span', { class: 'chat-after__arrow', 'aria-hidden': 'true' }) : null,
  dailyVal,
  q.count ? h('span', { class: 'chat-after__note', 'aria-hidden': 'true' }, cx(app, 'afterNote', { n: q.count }, '内政 {n} 件を含む')) : null);
}

// ---------- 各ボタンが今できるか（判定はエンジンに聞く） ----------

/**
 * @returns {{ok:boolean, reason?:string, meta:string, speech?:string, next:Array<{label:string, act:Function, primary?:boolean}>}}
 */
function menuState(app, squad, cmd) {
  const st = app.state;
  const db = app.db;
  const hero = heroOf(app, squad);
  const ap = squad.ap || 0;
  const apText = (n) => tf(app, 'chat.apCost', { n }, 'AP {n}');
  const ng = (reason, meta, extra = {}) => ({ ok: false, reason, meta, ...extra });
  const speech = (reason, vars = {}) => (SPEECH_REJECTS.has(reason) ? say(db, hero, `order.reject.${reason}`, vars) : null);
  switch (cmd) {
    case 'move': {
      // まわりのマスで一番安い 1 歩（pathfind.stepCost）。積めるかは validate に聞く
      const here = projectedTile(squad);
      let best = null;
      for (const n of neighbors(here, st.map.w, st.map.h)) {
        const cost = stepCost(st, db, squad, hero, n);
        if (Number.isFinite(cost) && (!best || cost < best.cost)) best = { n, cost };
      }
      if (!best) return ng('terrain', t(app, 'chat.ng.terrain'));
      const v = validate(st, db, squad, { type: 'move', path: [best.n] });
      if (!v.ok) return ng(v.reason, t(app, `chat.ng.${v.reason}`), { speech: speech(v.reason, { ap }) });
      return { ok: true, meta: tf(app, 'chat.apFrom', { n: best.cost }, 'AP {n}〜') };
    }
    case 'claim': {
      const order = { type: 'claim' };
      const v = validate(st, db, squad, order);
      if (!v.ok) return ng(v.reason, t(app, `chat.ng.${v.reason}`), { speech: speech(v.reason, { ap }) });
      return { ok: true, meta: apText(apCost(st, db, squad, order)) };
    }
    case 'build': {
      const tile = projectedTile(squad);
      const at = tile === squad.tile ? squad : { ...squad, tile };
      const kinds = Object.keys(db.facilities);
      const reasons = new Set();
      let apShort = false;
      let cost = null;
      for (const kind of kinds) {
        const v = validate(st, db, squad, { type: 'build', kind, rush: 0 });
        const c = apCost(st, db, squad, { type: 'build', kind, rush: 0 });
        if (cost == null || c < cost) cost = c;
        if (v.ok) return { ok: true, meta: apText(cost) };
        if (v.reason === 'ap') apShort = true;
        else reasons.add(canBuild(st, db, squad.land, tile, kind, at).reason);
      }
      if (apShort) return ng('ap', t(app, 'chat.ng.ap'), { speech: speech('ap', { ap }) });
      const one = reasons.size === 1 ? [...reasons][0] : null;
      // ボタンには短く、パネルには細目（自分のランドではない / 地形 など）を
      return ng('build', t(app, 'chat.ng.build'), { buildReason: one, speech: one ? t(app, `build.reason.${one}`) : null });
    }
    case 'attack': {
      const targets = findTargets(app, squad);
      if (targets.some((x) => x.ok)) return { ok: true, meta: apText(apCost(st, db, squad, { type: 'attack', target: targets[0].tile })) };
      if (targets.some((x) => x.reason === 'ap')) return ng('ap', t(app, 'chat.ng.ap'), { speech: speech('ap', { ap }) });
      if (targets.length) return ng('shield', t(app, 'chat.ng.shield'));
      return ng('range', t(app, 'chat.ng.range'), { speech: speech('range') });
    }
    case 'domestic': {
      // 内政のどれか 1 つでも積めれば開ける。徴兵だけで見ると、人口 0 の日（徴兵は "pop"）に農作も積めなくなる
      let first = null;
      for (const kind of DOMESTIC_KINDS) {
        const order = { type: 'domestic', kind };
        const v = validate(st, db, squad, order);
        if (v.ok) return { ok: true, meta: apText(apCost(st, db, squad, order)) };
        if (!first) first = v;
      }
      return ng(first.reason, t(app, `chat.ng.${first.reason}`), { speech: speech(first.reason, { ap }) });
    }
    case 'rest': {
      const v = validate(st, db, squad, { type: 'rest' });
      if (!v.ok) return ng(v.reason, t(app, `chat.ng.${v.reason}`), { speech: speech(v.reason, { ap }) });
      return { ok: true, meta: tf(app, 'chat.apAll', { n: ap }, 'AP 全部') };
    }
    case 'policy':
      return { ok: true, meta: tf(app, 'chat.apCost', { n: 0 }, 'AP {n}') };
    case 'clear': {
      const orders = squad.orders || [];
      if (!orders.length) return ng('none', t(app, 'chat.ng.none'));
      const back = orders.reduce((s, o) => s + (typeof o.ap === 'number' ? o.ap : 0), 0);
      return { ok: true, meta: tf(app, 'chat.apBack', { n: back }, 'AP +{n}') };
    }
    default:
      return { ok: true, meta: '' };
  }
}

/** できないときの次の一手（理由ごと）。押すと Map へ経路を引きに行く・占領する・休む・取り消す */
function nextSteps(app, squad, cmd, s) {
  const st = app.state;
  const out = [];
  const ap = squad.ap || 0;
  const orders = squad.orders || [];
  const back = orders.reduce((sum, o) => sum + (typeof o.ap === 'number' ? o.ap : 0), 0);
  const home = st.lands[st.playerLand] && st.lands[st.playerLand].home;
  const toMap = (label, tile) => ({ label, kind: 'map', act: () => { chatUi(app).menu = null; go('map', tile != null ? { squad: squad.id, tile } : { squad: squad.id }); } });
  // AP を使い切っているなら、どの理由でも動きようがない。取り消すか、指示を終えるかを返す
  const reason = ap <= 0 && s.reason !== 'none' ? 'ap' : s.reason;
  switch (reason) {
    case 'home':
      if (home != null) out.push(toMap(t(app, 'chat.next.home'), home));
      break;
    case 'range':
      out.push(toMap(t(app, 'chat.next.enemy')));
      break;
    case 'claim':
    case 'terrain':
    case 'shield':
      out.push(toMap(t(app, 'chat.next.map')));
      break;
    case 'build':
      // 自分の土地でないなら、まず占領（できるときだけ。判定は validate）
      if (s.buildReason === 'owner' && validate(st, app.db, squad, { type: 'claim' }).ok) {
        out.push({ label: t(app, 'chat.next.claim'), kind: 'do', act: () => { chatUi(app).menu = null; sendOrder(app, squad, { type: 'claim' }, t(app, 'cmd.claim')); } });
      }
      out.push(toMap(t(app, 'chat.next.buildSpot')));
      break;
    case 'ap':
      if (ap > 0 && validate(st, app.db, squad, { type: 'rest' }).ok) {
        // 押す前に、休息で何が動くかを見せる（兵 +0（人口 0）なら休んでも兵は増えない）
        const r = restPreview(app, squad);
        out.push({
          label: cx(app, 'fix.next.rest', { troops: restTroopsText(app, r), morale: signed(r.morale), n: ap }, '休息する（兵 {troops}・士気 {morale}・AP 全部 {n}）'),
          kind: 'do', act: () => { chatUi(app).menu = null; sendOrder(app, squad, { type: 'rest' }, t(app, 'cmd.rest')); },
        });
      }
      if (orders.length) {
        out.push({ label: tf(app, 'chat.next.clear', { n: back }), kind: 'undo', act: () => { chatUi(app).menu = null; doClear(app, squad); } });
      }
      // 「指示を終える → 次のヒーローへ / ターン終了」は下の主役ボタンが受け持つ（光って呼ぶ）
      break;
    default:
      break;
  }
  return out.filter(Boolean);
}

// ---------- リッチメニュー（2 行 × 4 列。AP の消費とできない理由つき） ----------

function richMenu(app, squad) {
  const c = chatUi(app);
  const shake = c.shake;
  c.shake = null;
  return h('nav', { class: 'chat-menu', 'aria-label': t(app, 'chat.menu') },
    MENU.map((cmd) => {
      const s = menuState(app, squad, cmd);
      return h('button', {
        class: ['chat-menu__btn', c.menu === cmd ? 'is-open' : null, s.ok ? null : 'is-ng', shake === cmd ? 'is-shake' : null],
        type: 'button', dataset: { cmd, ok: s.ok ? '1' : '0', reason: s.reason || null },
        'aria-expanded': SUBMENUS.has(cmd) || !s.ok ? String(c.menu === cmd) : null,
        'aria-label': `${t(app, `cmd.${cmd}`)}・${s.meta}`,
        onClick: () => onMenu(app, squad, cmd, s),
      },
      s.ok ? null : h('span', { class: 'chat-menu__dot', 'aria-hidden': 'true' }),
      h('span', { class: `chat-menu__icon chat-menu__icon--${cmd}`, 'aria-hidden': 'true' }),
      h('span', { class: 'chat-menu__label' }, t(app, `cmd.${cmd}`)),
      h('span', { class: ['chat-menu__meta', s.ok ? 'chat-menu__pill num' : 'is-ng'], 'aria-hidden': 'true' }, s.meta));
    }));
}

function onMenu(app, squad, cmd, s) {
  const c = chatUi(app);
  // できないとき（内政・戦闘は理由のうえに中身も見せる）: 理由と次の一手を返す
  if (!s.ok) {
    if (c.menu === cmd) { closeSheet(app); return; }
    c.menu = cmd;
    c.shake = cmd;
    // AP を使い切っているなら、次の一手は主役ボタン（指示を終える / 次のヒーローへ）。光らせて知らせる
    if ((squad.ap || 0) <= 0 || s.reason === 'ap' || s.reason === 'none') c.call = squad.id;
    rerender();
    return;
  }
  switch (cmd) {
    case 'move':
      c.menu = null;
      go('map', { squad: squad.id });
      return;
    case 'claim':
      c.menu = null;
      sendOrder(app, squad, { type: 'claim' }, t(app, 'cmd.claim'));
      return;
    case 'clear':
      c.menu = null;
      doClear(app, squad);
      return;
    default:
      if (c.menu === cmd) { closeSheet(app); return; }
      c.menu = cmd;
      rerender();
  }
}

function doClear(app, squad) {
  clearOrders(app.state, squad.id);
  setOrderDone(app, squad.id, false);
  pushMsg(app, squad.id, 'me', t(app, 'cmd.clear'));
  pushMsg(app, squad.id, 'sys', t(app, 'chat.cleared'));
  persist(app);
  rerender();
}

function submenu(app, squad) {
  const c = chatUi(app);
  if (!c.menu) return null;
  const s = menuState(app, squad, c.menu);
  // 内政と戦闘は、できないときも中身（何ができるようになるか）を薄く見せる
  // 戦闘で射程内に誰もいないときは、空の一覧を出さない（理由は返事が言う）
  const inner = c.menu === 'build' ? (s.ok ? buildMenu(app, squad) : null)
    : c.menu === 'attack' ? (s.ok || findTargets(app, squad).length ? attackMenu(app, squad) : null)
      : c.menu === 'domestic' ? domesticMenu(app, squad)
        : c.menu === 'rest' ? (s.ok ? restMenu(app, squad) : null)
          : c.menu === 'policy' ? policyMenu(app, squad) : null;
  if (s.ok) return inner;
  return blockedPanel(app, squad, c.menu, s, inner);
}

/** できない理由（ヒーローのことば）と次の一手 */
function blockedPanel(app, squad, cmd, s, inner) {
  const hero = heroOf(app, squad);
  const steps = nextSteps(app, squad, cmd, s);
  const line = s.speech || t(app, `chat.ngLong.${s.reason}`);
  return h('div', { class: 'chat-sub chat-next', role: 'group', dataset: { cmd, reason: s.reason }, 'aria-label': `${t(app, `cmd.${cmd}`)}・${s.meta}` },
    grabber(app),
    h('div', { class: 'chat-next__head' },
      heroImg(hero, { class: 'chat-next__img', width: 32, height: 32 }),
      h('div', { class: 'chat-next__say' },
        h('span', { class: 'chat-next__why' }, h('span', { class: 'chat-next__cmd' }, t(app, `cmd.${cmd}`)), s.meta),
        h('span', { class: 'chat-next__line' }, line))),
    steps.length
      ? h('div', { class: 'chat-next__acts' },
        h('span', { class: 'chat-next__title' }, t(app, 'chat.next')),
        steps.map((st, i) => h('button', {
          class: ['chat-next__btn', `chat-next__btn--${st.kind}`, i === 0 ? 'is-first' : null], type: 'button', dataset: { next: st.kind },
          onClick: st.act,
        }, h('span', { class: 'chat-next__arrow', 'aria-hidden': 'true' }), st.label)))
      : null,
    inner ? h('div', { class: 'chat-next__inner' }, inner) : null);
}

/** シートの上の取っ手（押すと閉じる。外をタップしても閉じる） */
function grabber(app) {
  return h('button', {
    class: 'chat-sub__grab', type: 'button', 'data-ripple': 'off', 'aria-label': t(app, 'common.close'),
    onClick: () => closeSheet(app),
  }, h('span', { 'aria-hidden': 'true' }));
}

function subPanel(app, titleKey, children, extra) {
  return h('div', { class: 'chat-sub', role: 'group', 'aria-label': t(app, titleKey) },
    grabber(app),
    h('div', { class: 'chat-sub__head' },
      h('span', { class: 'chat-sub__title' }, t(app, titleKey)),
      extra || null),
    h('div', { class: 'chat-sub__body' }, children));
}

// 開拓：施設 6 種を canBuild の結果つきで
function buildMenu(app, squad) {
  const st = app.state;
  const c = chatUi(app);
  const tile = projectedTile(squad);
  const at = tile === squad.tile ? squad : { ...squad, tile };
  const kinds = Object.keys(app.db.facilities);
  const buttons = kinds.map((kind) => {
    const r = canBuild(st, app.db, squad.land, tile, kind, at);
    const name = t(app, `facility.${kind}`);
    const rush = c.rush ? rushAp(app, squad, kind) : 0;
    const days = Math.max(1, r.days - rush);
    const apNeed = apCost(st, app.db, squad, { type: 'build', kind, rush });
    const meta = r.ok
      ? `${t(app, 'param.ap')} ${apNeed} ・ ${t(app, 'res.gum')} ${r.cost.gum} ・ ${t(app, 'res.mat')} ${r.cost.mat} ・ ${days}${t(app, 'chat.days')} ・ ${t(app, 'facility.rank')} ${r.toRank}`
      : t(app, `build.reason.${r.reason}`);
    return h('button', {
      class: 'chat-opt', type: 'button', disabled: !r.ok, dataset: { kind },
      onClick: () => {
        c.menu = null;
        const order = { type: 'build', kind, rush: c.rush ? rushAp(app, squad, kind) : 0 };
        sendOrder(app, squad, order, `${t(app, 'cmd.build')} ${name}`, { kind: name, days });
      },
    }, h('span', { class: 'chat-opt__name' }, name), h('span', { class: 'chat-opt__meta num' }, meta));
  });
  const toggle = h('button', {
    class: ['switch', 'chat-rush', c.rush ? 'is-on' : null], type: 'button', role: 'switch', 'aria-checked': c.rush ? 'true' : 'false',
    onClick: () => { c.rush = !c.rush; rerender(); },
  }, h('span', { class: 'switch__knob', 'aria-hidden': 'true' }), h('span', { class: 'switch__text' }, t(app, 'cmd.rush')));
  return subPanel(app, 'chat.buildTitle', buttons, toggle);
}

/** 余った AP（建築の AP を引いた残り）。数え方は engine の apCost に聞く */
function rushAp(app, squad, kind) {
  const base = apCost(app.state, app.db, squad, { type: 'build', kind, rush: 0 });
  return Math.max(0, (squad.ap || 0) - base);
}

// 戦闘：射程内の敵（部隊 / 砦 / 本拠地）
function attackMenu(app, squad) {
  const targets = findTargets(app, squad);
  const buttons = targets.length
    ? targets.map((x) => h('button', {
      class: ['chat-opt', x.ok ? null : 'is-ng'], type: 'button', dataset: { target: x.tile }, disabled: !!x.shielded,
      onClick: () => {
        chatUi(app).menu = null;
        sendOrder(app, squad, { type: 'attack', target: x.tile }, `${t(app, 'cmd.attack')} ${x.name}`, { target: x.name });
      },
    }, h('span', { class: 'chat-opt__name' }, x.name), h('span', { class: 'chat-opt__meta' }, x.meta)))
    : h('p', { class: 'muted chat-sub__empty' }, t(app, 'chat.noTargets'));
  return subPanel(app, 'chat.targets', buttons);
}

function findTargets(app, squad) {
  const st = app.state;
  const hero = heroOf(app, squad);
  if (!hero) return [];
  const { w, h: mh } = st.map;
  const from = projectedTile(squad);
  const explored = new Set((st.lands[st.playerLand] && st.lands[st.playerLand].explored) || []);
  const out = [];
  for (const tile of within(from, rangeOf(hero), w, mh)) {
    if (!explored.has(tile)) continue;
    const target = targetAt(st, squad.land, tile);
    if (!target) continue;
    const v = validate(st, app.db, squad, { type: 'attack', target: tile });
    if (!v.ok && v.reason !== 'ap') continue;
    const d = describeTarget(app, target);
    // 落ちたばかりの砦は実行時に止まるので、押せないようにして理由を出す（判定は engine の isShielded）
    if (target.rank && isShielded(st, target)) out.push({ tile, ...d, meta: t(app, 'map.shielded'), shielded: true, ok: false, reason: 'shield' });
    else out.push({ tile, ...d, ok: v.ok, reason: v.reason });
  }
  return out;
}

function describeTarget(app, target) {
  if (target.home) return { name: `${landLabel(app, target.home)}の${t(app, 'chat.toHome')}`, meta: t(app, 'map.home') };
  if (target.rank) {
    return { name: target.name, meta: `${t(app, 'fort.troops')} ${target.troops} ・ ${t(app, 'fort.durability')} ${target.durability}/${target.maxDurability}` };
  }
  const hero = heroOf(app, target);
  return { name: hero ? hero.name : target.id, meta: `${landLabel(app, target.land)} ・ ${t(app, 'param.troops')} ${target.troops}` };
}

function targetLabel(app, squad, tile) {
  const target = targetAt(app.state, squad.land, tile);
  return target ? describeTarget(app, target).name : '';
}

/** 見込みの 1 項目（「食料 +44」）。色だけに頼らず符号を書く */
function effectChip(label, n, suffix = '') {
  return h('span', { class: ['chat-eff', signCls(n)] }, h('span', { class: 'chat-eff__k' }, label), h('b', { class: 'num' }, `${signed(n)}${suffix}`));
}

/**
 * 内政 5 種（SPEC-114 §4）。各ボタンに economy.previewDomestic の見込み（この 1 回で動く量・1 日の食料の変化・あと何回）と、
 * このヒーローに積んだ回数「×N」。押してもシートは閉じない（続けて積める）。AP が尽きて内政がもう積めなくなったら閉じる。
 */
/** 内政で増やす主な値（0 なら積んでも何も起きない）。delta のキーと、見出しの文言 */
const DOMESTIC_MAIN = {
  conscript: { key: 'troops', label: 'param.troops' },
  farm: { key: 'food', label: 'res.food', cap: 'food' },
  trade: { key: 'gum', label: 'res.gum' },
  craft: { key: 'mat', label: 'res.mat', cap: 'mat' },
  reward: { key: 'morale', label: null },
};

/**
 * 積んだ指示のあとの写しで見た、そのランドの人口・その部隊の兵と上限（ledger-view.plannedState。エンジンの domestic / rest を
 * 写しに当てたもの）。徴兵・休息で兵が増えない理由（人口 0 / 兵が上限）を書くために使う。数を足し引きし直さない。
 */
function plannedCtx(app, squad) {
  const sim = plannedState(app, squad.land);
  const s = sim.squads[squad.id] || squad;
  const hero = heroOf(app, squad);
  const land = sim.lands[squad.land];
  return {
    sim, s, pop: land ? land.res.pop || 0 : 0, troops: s.troops || 0,
    cap: hero ? troopCap(hero, s, app.db) : 0,
    muster: hero ? musterCap(hero, s, app.db) : 0, // 休息で戻せるのは定員まで（SPEC-113 §2.1）
  };
}

/**
 * 内政を積んでも何も増えないときの理由（engine の previewDomestic が ok でも、主な値が 0 のとき）。
 * 徴兵：人口 0 / 人口が足りない / 兵が上限、農作・工作：倉庫いっぱい（上限は economy.caps）、恩賞：士気が上限。
 * @returns {null|{reason:string, text:string}}
 */
function domesticBlock(app, squad, kind, p, ctx) {
  if (!p.ok) return null;
  const main = DOMESTIC_MAIN[kind];
  if (!main || p.delta[main.key] > 0) return null;
  if (kind === 'conscript') {
    if (ctx.cap > 0 && ctx.troops >= ctx.cap) return { reason: 'troopCap', text: cx(app, 'fix.ng.troopCap', { n: ctx.cap }, '兵が上限（{n}）') };
    if (ctx.pop <= 0) return { reason: 'pop', text: cx(app, 'fix.ng.pop0', {}, '人口 0') };
    return { reason: 'pop', text: cx(app, 'fix.ng.popLow', { n: ctx.pop }, '人口が足りない（人口 {n}）') };
  }
  if (main.cap) {
    const cap = caps(app.state, app.db, squad.land)[main.cap];
    return { reason: 'cap', text: cx(app, 'fix.ng.storeFull', { n: cap }, '倉庫いっぱい（上限 {n}）') };
  }
  if (kind === 'reward') return { reason: 'moraleMax', text: cx(app, 'fix.ng.moraleMax', { n: MORALE_MAX }, '士気が上限（{n}）') };
  return { reason: 'none', text: cx(app, 'noEffect', {}, '変化なし') };
}

/**
 * これを 1 回積んだら、次の 1 回は何も増えなくなるか（倉庫・士気が上限に届く）。もう 1 回積んだ写しで previewDomestic に聞く。
 */
function fillsUp(app, squad, kind) {
  const main = DOMESTIC_MAIN[kind];
  if (!main || !(main.cap || kind === 'reward')) return false;
  const st = app.state;
  const order = { type: 'domestic', kind };
  const ap = apCost(st, app.db, squad, order);
  const s2 = { ...squad, orders: [...(squad.orders || []), { ...order, ap }], ap: (squad.ap || 0) - ap };
  const next = previewDomestic({ ...st, squads: { ...st.squads, [squad.id]: s2 } }, app.db, s2, kind);
  return next.delta[main.key] <= 0;
}

function domesticMenu(app, squad) {
  const st = app.state;
  const c = chatUi(app);
  const bump = c.bump;
  c.bump = null;
  const shake = c.shakeDom;
  c.shakeDom = null;
  const ctx = plannedCtx(app, squad);
  const perDay = (n) => cx(app, 'perDay', { n }, '{n}/日');
  const buttons = DOMESTIC_KINDS.map((kind) => {
    const name = domName(app, kind);
    const p = previewDomestic(st, app.db, squad, kind);
    const d = p.delta;
    const n = (squad.orders || []).filter((o) => o.type === 'domestic' && o.kind === kind).length;
    const block = domesticBlock(app, squad, kind, p, ctx);
    const ok = p.ok && !block;
    const effects = [];
    if (block) {
      // 何も増えないときは、増やすはずの値が ±0 であることだけ（食料 ±0/日 のような、押せそうに見える書き方をしない）
      const main = DOMESTIC_MAIN[kind];
      effects.push(effectChip(main.label ? t(app, main.label) : cx(app, 'morale', {}, '士気'), 0));
    } else {
      // 徴兵は「兵 +N」を先頭に、続けて 1 日の食料の変化と人口
      if (d.troops) effects.push(effectChip(t(app, 'param.troops'), d.troops));
      if (d.food) effects.push(effectChip(t(app, 'res.food'), d.food));
      // 1 日の食料の変化（徴兵）。農作は delta.food と同じ値なので重ねない
      if (kind !== 'farm' && (p.perDay.food || kind === 'conscript')) effects.push(effectChip(t(app, 'res.food'), p.perDay.food, perDay('').trim()));
      if (d.pop) effects.push(effectChip(t(app, 'res.pop'), d.pop));
      if (d.gum) effects.push(effectChip(t(app, 'res.gum'), d.gum));
      if (d.mat) effects.push(effectChip(t(app, 'res.mat'), d.mat));
      if (d.morale) effects.push(effectChip(cx(app, 'morale', {}, '士気'), d.morale));
      if (!effects.length) effects.push(h('span', { class: 'chat-eff is-zero' }, cx(app, 'noEffect', {}, '変化なし')));
    }
    const foot = block ? block.text
      : p.ok ? (fillsUp(app, squad, kind)
        ? (DOMESTIC_MAIN[kind].cap
          ? cx(app, 'fix.fillsStore', { n: caps(st, app.db, squad.land)[DOMESTIC_MAIN[kind].cap] }, 'これで倉庫が上限（{n}）')
          : cx(app, 'fix.fillsMorale', { n: MORALE_MAX }, 'これで士気が上限（{n}）'))
        : cx(app, 'repeat', { n: p.repeat }, 'あと {n} 回'))
        : p.reason === 'gum' ? cx(app, 'ng.gum', { n: -d.gum }, 'GUM が足りない（{n} 要る）')
          : cx(app, `ng.${p.reason}`, {}, t(app, `chat.ng.${p.reason}`));
    const aria = `${name}・${effects.map((e) => e.textContent).join('・')}・${foot}${n ? `・${cx(app, 'countAria', { n }, '{n} 回積んだ')}` : ''}`;
    return h('button', {
      class: ['chat-opt', 'chat-dom', ok ? null : 'is-ng', n ? 'has-count' : null, shake === kind ? 'is-shake' : null], type: 'button',
      dataset: { kind, ok: ok ? '1' : '0', reason: block ? block.reason : p.reason || null, repeat: ok ? p.repeat : 0, count: n },
      'aria-label': aria,
      onClick: () => pickDomestic(app, squad, kind, name),
    },
    h('span', { class: 'chat-dom__top', 'aria-hidden': 'true' },
      h('span', { class: 'chat-opt__name' }, name),
      n ? h('span', { class: ['chat-dom__count', 'num', bump === kind ? 'is-bump' : null] }, cx(app, 'count', { n }, '×{n}')) : null),
    h('span', { class: 'chat-dom__eff', 'aria-hidden': 'true' }, effects),
    h('span', { class: ['chat-dom__foot', ok ? null : 'is-ng'], 'aria-hidden': 'true' }, foot));
  });
  return subPanel(app, 'chat.domesticTitle', h('div', { class: 'chat-sub__grid chat-sub__grid--dom' }, buttons),
    h('span', { class: 'muted chat-sub__now' }, cx(app, 'domHint', {}, '押すたびに 1 回ずつ積む（AP 2）')));
}

/** 内政を 1 回積む。シートは開いたまま（SPEC-114 §4）。内政がもう積めない AP になったら沈めて閉じる */
function pickDomestic(app, squad, kind, name) {
  const c = chatUi(app);
  // 積んでも何も増えない（人口 0・倉庫いっぱい など）なら積まない。理由を返して、ボタンを揺らす（AP を無駄にさせない）
  const block = domesticBlock(app, squad, kind, previewDomestic(app.state, app.db, squad, kind), plannedCtx(app, squad));
  if (block) {
    pushMsg(app, squad.id, 'sys', cx(app, 'fix.blocked', { kind: name, why: block.text }, '{kind}は積まなかった：{why}'));
    c.shakeDom = kind;
    rerender();
    return;
  }
  const r = sendOrder(app, squad, { type: 'domestic', kind }, `${t(app, 'cmd.domestic')} ${name}`, { kind: name }, { keepSheet: true });
  if (!r.ok) return;
  c.bump = kind;
  if ((squad.ap || 0) < apCost(app.state, app.db, squad, { type: 'domestic', kind })) closeSheet(app);
  else rerender();
}

/**
 * 休息を積んだらどうなるか: 積んだ指示のあとの写し（plannedCtx）に、エンジンの economy.rest をそのまま当てて読む。
 * full は兵が定員まで戻っている（休息で戻せるのは定員まで。SPEC-113 §2.1）。
 * @returns {{troops:number, morale:number, pop:number, full:boolean}}
 */
function restPreview(app, squad) {
  const ctx = plannedCtx(app, squad);
  const full = ctx.muster > 0 ? ctx.troops >= ctx.muster : ctx.cap > 0 && ctx.troops >= ctx.cap;
  const ev = restOn(ctx.sim, app.db, ctx.s);
  return { troops: ev.amount, morale: ev.morale ? ev.morale.delta : 0, pop: ctx.pop, full };
}

/** 休息で増える兵の書き方。0 のときは理由を添える（「+0（人口 0）」「+0（定員）」） */
function restTroopsText(app, r) {
  if (r.troops > 0) return signed(r.troops);
  return r.full ? cx(app, 'fix.rest.muster', { n: signed(0) }, '{n}（定員）') : cx(app, 'fix.rest.pop0', { n: signed(0) }, '{n}（人口 0）');
}

// 休息：押す前に見込み（兵・士気・AP 全部）を出す。押したら積んで閉じる
function restMenu(app, squad) {
  const r = restPreview(app, squad);
  const ap = squad.ap || 0;
  const name = cx(app, 'fix.rest.do', {}, '休息する');
  const troops = h('span', { class: ['chat-eff', signCls(r.troops)] },
    h('span', { class: 'chat-eff__k' }, t(app, 'param.troops')), h('b', { class: 'num' }, restTroopsText(app, r)));
  const effects = [troops, effectChip(cx(app, 'morale', {}, '士気'), r.morale),
    h('span', { class: 'chat-eff chat-eff--ap' }, h('span', { class: 'chat-eff__k' }, t(app, 'param.ap')), h('b', { class: 'num' }, cx(app, 'fix.rest.apAll', { n: ap }, '全部 {n}')))];
  const warn = r.troops <= 0;
  const btn = h('button', {
    class: ['chat-opt', 'chat-rest', warn ? 'is-warn' : null], type: 'button', dataset: { act: 'rest', troops: r.troops, morale: r.morale },
    'aria-label': `${name}・${effects.map((e) => e.textContent).join('・')}`,
    onClick: () => {
      chatUi(app).menu = null;
      // 返事のあとに見込みを 1 行残す（「兵の回復を優先します」と言っても、人口 0 なら兵は増えない）
      const res = sendOrder(app, squad, { type: 'rest' }, t(app, 'cmd.rest'), {}, { keepSheet: true });
      if (res.ok) pushMsg(app, squad.id, 'sys', cx(app, 'fix.rest.queued', { troops: restTroopsText(app, r), morale: signed(r.morale) }, '見込み：兵 {troops}・士気 {morale}'));
      rerender();
    },
  },
  h('span', { class: 'chat-opt__name', 'aria-hidden': 'true' }, name),
  h('span', { class: 'chat-dom__eff', 'aria-hidden': 'true' }, effects),
  warn ? h('span', { class: 'chat-dom__foot is-ng', 'aria-hidden': 'true' },
    r.full ? cx(app, 'fix.rest.noteMuster', {}, '兵は定員まで戻っている。上がるのは士気だけ（定員を超えて増やすには徴兵）') : cx(app, 'fix.rest.notePop', {}, '人口が 0 なので兵は増えない。上がるのは士気だけ')) : null);
  return subPanel(app, 'chat114.fix.rest.title', btn,
    h('span', { class: 'muted chat-sub__now' }, cx(app, 'fix.rest.hint', {}, '兵の回復は人口を使う（兵 1 人に人口 1）')));
}

// 方針 3 種（squad.policy を直接変える）
function policyMenu(app, squad) {
  const buttons = POLICIES.map((p) => {
    const name = t(app, `policy.${p}`);
    const now = squad.policy === p;
    return h('button', {
      class: ['chat-opt', 'chat-opt--small', now ? 'is-current' : null], type: 'button', dataset: { policy: p }, 'aria-pressed': now ? 'true' : 'false',
      onClick: () => {
        chatUi(app).menu = null;
        squad.policy = p;
        pushMsg(app, squad.id, 'me', `${t(app, 'cmd.policy')} ${name}`);
        pushMsg(app, squad.id, 'hero', say(app.db, heroOf(app, squad), 'order.policy.ack', { kind: name }));
        persist(app);
        rerender();
      },
    }, h('span', { class: 'chat-opt__name' }, name));
  });
  return subPanel(app, 'chat.policyTitle', h('div', { class: 'chat-sub__grid' }, buttons),
    h('span', { class: 'muted chat-sub__now' }, `${t(app, 'chat.policyNow')}: ${t(app, `policy.${squad.policy}`)}`));
}

// ------------------------------------------------------------
// ロスターと主役ボタン（SPEC-112 §7.5.2）
// ------------------------------------------------------------

function dock(app, squad, o = {}) {
  const c = chatUi(app);
  const list = mySquads(app);
  const idx = list.findIndex((s) => s.id === squad.id);
  const roster = h('ol', {
    class: ['chat-roster', o.folded ? 'is-folded' : null, o.fold ? `is-${o.fold}` : null],
    'aria-label': tf(app, 'chat.roster', {}, 'ヒーローの並び'), 'aria-hidden': o.folded ? 'true' : null, inert: o.folded ? '' : null,
  },
    list.map((s, i) => {
      const hero = heroOf(app, s);
      const kind = orderStatus(app, s);
      const max = hero ? apMax(hero, s, app.db) : 0;
      const cur = s.id === squad.id;
      return h('li', null, h('button', {
        class: ['chat-roster__btn', `is-${kind}`, cur ? 'is-current' : null], type: 'button', dataset: { squad: s.id, status: kind },
        'aria-current': cur ? 'true' : null,
        'aria-label': `${hero ? hero.name : s.id}・${t(app, `home.status.${kind}`)}・AP ${s.ap || 0}/${max}`,
        onClick: () => { if (!cur) openTalk(app, s.id, i < idx ? -1 : 1); },
      }, apRing(heroImg(hero, { class: 'chat-roster__img', width: 36, height: 36 }), s.ap || 0, max, kind),
      h('span', { class: `chat-roster__mark chat-roster__mark--${kind}`, 'aria-hidden': 'true' })));
    }));

  const kind = orderStatus(app, squad);
  const nx = nextSquad(app, squad.id);
  const marked = app.ui.orderDone && app.ui.orderDone[squad.id] === app.state.day;
  let btn;
  if (kind === 'doing') {
    btn = primaryBtn(app, 'finish', nx
      ? tf(app, 'chat.finishNext', { name: heroName(app, nx) }, '指示を終える → 次のヒーローへ（{name}）')
      : tf(app, 'chat.finishLast', {}, '指示を終える'), () => finishHero(app, squad));
  } else if (kind === 'none') {
    // まだ何も積んでいない: 主役にはしない（控えめに「あとで」）
    // まだ何も積んでいない: 主役にはしない。枠つきの副ボタン（右端に「＞」）
    btn = nx
      ? subBtn(app, 'skip', tf(app, 'chat.skipTo', { name: heroName(app, nx) }, 'あとで（{name} へ）'), () => openTalk(app, nx.id, 1), nx.id)
      : subBtn(app, 'finish', tf(app, 'chat.finishEmpty', {}, '指示なしで終える'), () => finishHero(app, squad));
  } else if (nx) {
    // 完了・休み（AP 0 も含む）: 次のヒーローへ。押すと完了にして移る
    btn = primaryBtn(app, 'next', tf(app, 'chat.nextHero', { name: heroName(app, nx) }, '次のヒーローへ（{name}）'), () => finishHero(app, squad));
  } else {
    btn = primaryBtn(app, 'end', tf(app, 'chat.allDone', {}, '全員の指示が完了 → ターン終了'), () => { if (kind !== 'off' && !marked) setOrderDone(app, squad.id, true); endTurn(); });
  }
  // AP を使い切った直後は、0.6 秒後に主役ボタンが光る（自動では移らない）
  if (c.call === squad.id && btn && btn.classList) { btn.classList.add('is-call'); c.call = null; }
  return h('div', { class: 'chat-dock' }, roster, btn);
}

function subBtn(app, act, label, onClick, squadId) {
  return h('button', { class: 'chat-primary chat-primary--sub', type: 'button', dataset: { act, squad: squadId || null }, onClick },
    h('span', { class: 'chat-primary__main' }, label), h('span', { class: 'chat-primary__chev', 'aria-hidden': 'true' }));
}

function primaryBtn(app, act, label, onClick) {
  return h('button', { class: 'btn-primary chat-primary', type: 'button', dataset: { act }, 'data-ripple': 'accent', onClick },
    h('span', { class: 'chat-primary__main' }, label), h('span', { class: 'chat-primary__arrow', 'aria-hidden': 'true' }));
}

/** 「指示を終える」: 完了にして、次の未指示 / 指示中のヒーローへめくる。いなければその場で全員完了の案内 */
function finishHero(app, squad) {
  const kind = orderStatus(app, squad);
  if (kind !== 'off') setOrderDone(app, squad.id, true);
  const nx = nextSquad(app, squad.id);
  if (nx) {
    const list = mySquads(app);
    const dir = list.findIndex((s) => s.id === nx.id) < list.findIndex((s) => s.id === squad.id) ? -1 : 1;
    openTalk(app, nx.id, dir);
  } else {
    chatUi(app).menu = null;
    rerender();
  }
}

// ------------------------------------------------------------
// 指示を送る（成否はエンジンの queue が決める）
// ------------------------------------------------------------

function sendOrder(app, squad, order, myText, vars = {}, opt = {}) {
  const hero = heroOf(app, squad);
  const c = chatUi(app);
  pushMsg(app, squad.id, 'me', myText);
  const r = queue(app.state, app.db, squad.id, order);
  if (r.ok) {
    pushMsg(app, squad.id, 'hero', ackLine(app, hero, order, vars));
    // 指示を足したら「完了」は外す（指示中に戻る）
    if (app.ui.orderDone && app.ui.orderDone[squad.id] != null) setOrderDone(app, squad.id, false);
    if ((squad.ap || 0) <= 0) c.call = squad.id;
    persist(app);
  } else if (SPEECH_REJECTS.has(r.reason)) {
    const rv = r.reason === 'ap' ? { ap: squad.ap } : r.reason === 'build' ? { kind: vars.kind } : {};
    pushMsg(app, squad.id, 'hero', say(app.db, hero, `order.reject.${r.reason}`, rv));
  } else {
    pushMsg(app, squad.id, 'sys', tk(app, `chat.reject.${r.reason}`, {}, t(app, `chat.ng.${r.reason}`)));
  }
  // 続けて積むとき（内政）は、呼んだ側が描き直す（シートを閉じるかどうかを決めてから）
  if (!(opt.keepSheet && r.ok)) rerender();
  return r;
}

/**
 * 指示を受けたヒーローの返事。徴兵は内政の共通の返事（「民の暮らしを整えてやろう」など）が中身と合わないので、
 * 口調ごとの徴兵の返事（ui の chat114.fix.ack.conscript.<口調>）にする。無ければ共通の返事。
 */
function ackLine(app, hero, order, vars) {
  const base = () => say(app.db, hero, `order.${order.type}.ack`, vars);
  if (order.type !== 'domestic' || order.kind !== 'conscript') return base();
  const tone = (hero && hero.tone) || 'plain';
  const key = `chat114.fix.ack.conscript.${tone}`;
  const s = uiText(app.db, key);
  return s === key ? base() : s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? m : String(vars[k])));
}

/** 「1 手戻す」: 最後の指示だけ外して AP を戻す（orders.undoLast）。完了の印も外す */
function doUndo(app, squad) {
  const r = undoLast(app.state, squad.id);
  if (!r.ok) return;
  const label = orderLabel(app, squad, r.order);
  setOrderDone(app, squad.id, false);
  pushMsg(app, squad.id, 'me', cx(app, 'undo', {}, '1 手戻す'));
  pushMsg(app, squad.id, 'sys', cx(app, 'undone', { order: label, n: r.ap }, '「{order}」を外した（AP +{n}）'));
  persist(app);
  rerender();
}

function persist(app) {
  try { save(app.state); } catch (e) { console.error(e); }
}
