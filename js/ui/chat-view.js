// chat-view.js — MCH Chat（メッセージアプリ風の指示。SPEC-111 §4）
//
// トークの一覧（マインちゃん + 自分のヒーロー）→ トーク（吹き出し・積んだ指示・リッチメニュー）。
// ゲームのルールはここに書かない。AP・建てられるか・射程・内政の可否は engine に聞く
// （orders.validate / queue / apMax / apCost、economy.canBuild、hex.within + heroes.rangeOf、turn.targetAt）。
//
// トークの履歴は app.ui.chat に持つ（state に入れない。リロードで消えてよい）:
//   app.ui.chat = { key, history: { [talkId]: Msg[] }, greeted: { [squadId]: day }, menu, rush, reported }
//   Msg = { who: "hero"|"me"|"sys", text }
//   talkId は "mai" か squadId。app.ui.chatSquad が開いているトーク（null で一覧）。

import { h, heroImg, imgEl } from './h.js';
import { uiText, say } from '../engine/lines.js';
import { queue, validate, clearOrders, apMax, apCost, projectedTile } from '../engine/orders.js';
import { canBuild, DOMESTIC_KINDS } from '../engine/economy.js';
import { within } from '../engine/hex.js';
import { rangeOf } from '../engine/heroes.js';
import { targetAt, isShielded } from '../engine/turn.js';
import { save } from '../state.js';
import { go, render as rerender, pendingApp } from '../main.js';

const MAI_ID = 'mai';
const MAI_IMAGE = 'Image/Icons/mai_sd.png';
const MAX_HISTORY = 60;
const MAI_NOTICES = 30;
const POLICIES = ['ignore', 'fight', 'ask'];
const MENU = ['move', 'claim', 'build', 'attack', 'domestic', 'rest', 'policy', 'clear'];
/** 引数つきのセリフが無い reject.* の理由（ui の chat.reject.* で出す） */
const SPEECH_REJECTS = new Set(['ap', 'home', 'range', 'build']);

const t = (app, key) => uiText(app.db, key);

// ------------------------------------------------------------
// app.ui.chat（画面だけの状態）
// ------------------------------------------------------------

function chatUi(app) {
  const st = app.state;
  const key = st ? `${st.seed}:${st.playerLand}` : '';
  let c = app.ui.chat;
  // 新しいゲームでは squadId（s1, s2, ...）が使い回されるので、履歴を作り直す
  if (!c || c.key !== key) {
    c = { key, history: {}, greeted: {}, menu: null, rush: false, reported: null };
    app.ui.chat = c;
  }
  return c;
}

function pushMsg(app, talkId, who, text) {
  const c = chatUi(app);
  const list = c.history[talkId] || (c.history[talkId] = []);
  list.push({ who, text });
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
    else if (ev.t === 'domestic' && (s = mine(ev.squad))) {
      text = say(app.db, heroOf(app, s), 'report.domestic', { kind: t(app, `domestic.${ev.kind}`), n: ev.amount });
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

export function render(app) {
  const c = chatUi(app);
  absorbReports(app);
  const id = app.ui.chatSquad;
  if (id === MAI_ID) return renderMai(app);
  const squad = id != null ? app.state.squads[id] : null;
  if (squad && squad.land === app.state.playerLand) return renderTalk(app, squad);
  if (id != null) app.ui.chatSquad = null;
  c.menu = null;
  return renderList(app);
}

function openTalk(app, id) {
  const c = chatUi(app);
  c.menu = null;
  c.rush = false;
  app.ui.chatSquad = id;
  if (id !== MAI_ID) app.ui.selectedSquad = id;
  rerender();
}

function backToList(app) {
  const c = chatUi(app);
  c.menu = null;
  app.ui.chatSquad = null;
  rerender();
}

// ---------- トークの一覧 ----------

function renderList(app) {
  const st = app.state;
  const c = chatUi(app);
  const notices = st.notices || [];
  const lastNotice = notices.length ? notices[notices.length - 1].text : t(app, 'chat.mineEmpty');
  const pa = pendingApp();
  const squads = mySquads(app);

  const maiRow = h('li', null,
    h('button', { class: 'chat-row chat-row--mai', type: 'button', onClick: () => openTalk(app, MAI_ID) },
      imgEl(MAI_IMAGE, t(app, 'chat.mine'), { class: 'chat-row__img chat-row__img--mai' }),
      h('span', { class: 'chat-row__main' },
        h('span', { class: 'chat-row__name' }, t(app, 'chat.mine')),
        h('span', { class: 'chat-row__last' }, pa ? t(app, 'chat.pending') : lastNotice)),
      pa ? h('span', { class: 'chat-row__badge', 'aria-label': t(app, 'home.pending') }, '!') : null));

  const rows = squads.map((s) => {
    const hero = heroOf(app, s);
    const hist = c.history[s.id] || [];
    const last = hist.length ? hist[hist.length - 1].text : summary(app, s) || t(app, 'chat.noLine');
    const max = hero ? apMax(hero, s, app.db) : 0;
    return h('li', null,
      h('button', { class: 'chat-row', type: 'button', dataset: { squad: s.id }, onClick: () => openTalk(app, s.id) },
        heroImg(hero, { class: 'chat-row__img', width: 64, height: 64 }),
        h('span', { class: 'chat-row__main' },
          h('span', { class: 'chat-row__name' }, hero ? hero.name : s.id,
            s.status === 'routed' ? h('span', { class: 'chat-tag chat-tag--bad' }, t(app, 'chat.routed')) : null),
          h('span', { class: 'chat-row__last' }, last)),
        h('span', { class: 'chat-row__ap num', 'aria-label': `${t(app, 'chat.apLeft')} ${s.ap} / ${max}` },
          h('span', { class: 'chat-row__ap-label' }, t(app, 'param.ap')),
          `${s.ap}/${max}`)));
  });

  return h('section', { class: 'app-screen chat chat--list' },
    h('h1', { class: 'app-title' }, t(app, 'app.chat')),
    h('ul', { class: 'chat-list', 'aria-label': t(app, 'chat.list') },
      maiRow,
      rows.length ? rows : h('li', { class: 'empty muted' }, t(app, 'chat.noSquads'))));
}

// ---------- マインちゃん（ホームの通知と同じ内容） ----------

function renderMai(app) {
  const st = app.state;
  const notices = (st.notices || []).slice(-MAI_NOTICES);
  const pa = pendingApp();
  const items = [];
  items.push(bubbleHero(app, null, t(app, 'chat.mineLead'), true));
  if (!notices.length) items.push(bubbleHero(app, null, t(app, 'chat.mineEmpty'), true));
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
    items.push(bubbleHero(app, null, body, true));
  }
  if (pa) {
    items.push(bubbleHero(app, null,
      h('button', { class: 'chat-bubble__link', type: 'button', onClick: () => go(pa) },
        t(app, 'chat.pending'), h('span', { class: 'chat-bubble__app' }, t(app, `app.${pa}`).replace(/^MCH /, ''))), true));
  }
  return h('section', { class: 'chat chat--talk' },
    talkHead(app, imgEl(MAI_IMAGE, t(app, 'chat.mine'), { class: 'chat-head__img chat-head__img--mai' }), t(app, 'chat.mine'), null),
    h('ol', { class: 'chat-log', 'aria-live': 'polite' }, items));
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
  const max = hero ? apMax(hero, squad, app.db) : 0;
  const hist = c.history[squad.id] || [];
  const log = h('ol', { class: 'chat-log', 'aria-live': 'polite' },
    hist.map((m) => m.who === 'me' ? bubbleMe(m.text) : m.who === 'sys' ? h('li', { class: 'chat-sys' }, m.text) : bubbleHero(app, hero, m.text)));

  const apEl = h('span', { class: 'chat-head__ap num' },
    h('span', { class: 'muted' }, t(app, 'chat.apLeft')), ` ${squad.ap} / ${max}`);

  return h('section', { class: 'chat chat--talk', dataset: { squad: squad.id } },
    talkHead(app, heroImg(hero, { class: 'chat-head__img', width: 40, height: 40 }), hero ? hero.name : squad.id, apEl),
    queuedStrip(app, squad),
    log,
    canOrder(app) ? submenu(app, squad) : null,
    canOrder(app) ? richMenu(app, squad) : h('p', { class: 'chat-locked muted' }, t(app, 'chat.locked')));
}

export function mount(app, el) {
  // 吹き出しは下に積むので、いちばん下を見せる
  const log = el && el.querySelector('.chat-log');
  if (log) log.scrollTop = log.scrollHeight;
}

function talkHead(app, imgNode, name, extra) {
  return h('header', { class: 'chat-head' },
    h('button', { class: 'btn-ghost chat-head__back', type: 'button', 'aria-label': t(app, 'chat.back'), onClick: () => backToList(app) },
      h('span', { class: 'chat-head__chev', 'aria-hidden': 'true' }), t(app, 'chat.title')),
    imgNode,
    h('span', { class: 'chat-head__name' }, name),
    extra);
}

function bubbleHero(app, hero, content, mai = false) {
  const avatar = mai
    ? imgEl(MAI_IMAGE, t(app, 'chat.mine'), { class: 'chat-msg__img chat-msg__img--mai' })
    : heroImg(hero, { class: 'chat-msg__img', width: 32, height: 32 });
  return h('li', { class: 'chat-msg chat-msg--them' }, avatar, h('div', { class: 'chat-bubble' }, content));
}

function bubbleMe(text) {
  return h('li', { class: 'chat-msg chat-msg--me' }, h('div', { class: 'chat-bubble chat-bubble--me' }, text));
}

// ---------- 積んだ指示 ----------

function orderLabel(app, squad, o) {
  switch (o.type) {
    case 'move': return `${t(app, 'cmd.move')} ${o.path ? o.path.length : 0}`;
    case 'build': return `${t(app, 'cmd.build')} ${t(app, `facility.${o.kind}`)}`;
    case 'attack': return `${t(app, 'cmd.attack')} ${targetLabel(app, squad, o.target)}`;
    case 'domestic': return `${t(app, 'cmd.domestic')} ${t(app, `domestic.${o.kind}`)}`;
    default: return t(app, `cmd.${o.type}`);
  }
}

function summary(app, squad) {
  return (squad.orders || []).map((o) => orderLabel(app, squad, o)).join(' → ');
}

function queuedStrip(app, squad) {
  const orders = squad.orders || [];
  return h('div', { class: 'chat-queue' },
    h('span', { class: 'chat-queue__label' }, t(app, 'chat.queued')),
    orders.length
      ? h('ol', { class: 'chat-queue__list' }, orders.map((o, i) => h('li', { class: 'chat-queue__item' },
        i > 0 ? h('span', { class: 'chat-queue__arrow', 'aria-hidden': 'true' }, '→') : null, orderLabel(app, squad, o))))
      : h('span', { class: 'chat-queue__none muted' }, t(app, 'chat.noOrders')));
}

// ---------- リッチメニュー（2 行 × 4 列） ----------

function richMenu(app, squad) {
  const c = chatUi(app);
  return h('nav', { class: 'chat-menu', 'aria-label': t(app, 'chat.menu') },
    MENU.map((cmd) => h('button', {
      class: ['chat-menu__btn', c.menu === cmd ? 'is-open' : null], type: 'button', dataset: { cmd },
      'aria-expanded': ['build', 'attack', 'domestic', 'policy'].includes(cmd) ? String(c.menu === cmd) : null,
      onClick: () => onMenu(app, squad, cmd),
    }, h('span', { class: `chat-menu__icon chat-menu__icon--${cmd}`, 'aria-hidden': 'true' }), t(app, `cmd.${cmd}`))));
}

function onMenu(app, squad, cmd) {
  const c = chatUi(app);
  switch (cmd) {
    case 'move':
      c.menu = null;
      go('map', { squad: squad.id });
      return;
    case 'claim':
      c.menu = null;
      sendOrder(app, squad, { type: 'claim' }, t(app, 'cmd.claim'));
      return;
    case 'rest':
      c.menu = null;
      sendOrder(app, squad, { type: 'rest' }, t(app, 'cmd.rest'));
      return;
    case 'clear':
      c.menu = null;
      clearOrders(app.state, squad.id);
      pushMsg(app, squad.id, 'me', t(app, 'cmd.clear'));
      pushMsg(app, squad.id, 'sys', t(app, 'chat.cleared'));
      persist(app);
      rerender();
      return;
    default:
      c.menu = c.menu === cmd ? null : cmd;
      rerender();
  }
}

function submenu(app, squad) {
  const c = chatUi(app);
  if (c.menu === 'build') return buildMenu(app, squad);
  if (c.menu === 'attack') return attackMenu(app, squad);
  if (c.menu === 'domestic') return domesticMenu(app, squad);
  if (c.menu === 'policy') return policyMenu(app, squad);
  return null;
}

function subPanel(app, titleKey, children, extra) {
  return h('div', { class: 'chat-sub', role: 'group', 'aria-label': t(app, titleKey) },
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
    const meta = r.ok
      ? `${t(app, 'res.gum')} ${r.cost.gum} ・ ${t(app, 'res.mat')} ${r.cost.mat} ・ ${days}${t(app, 'chat.days')} ・ ${t(app, 'facility.rank')} ${r.toRank}`
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
      class: 'chat-opt', type: 'button', dataset: { target: x.tile }, disabled: !!x.shielded,
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
    if (target.rank && isShielded(st, target)) out.push({ tile, ...d, meta: t(app, 'map.shielded'), shielded: true });
    else out.push({ tile, ...d });
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

// 内政 4 種
function domesticMenu(app, squad) {
  const buttons = DOMESTIC_KINDS.map((kind) => {
    const name = t(app, `domestic.${kind}`);
    return h('button', {
      class: 'chat-opt chat-opt--small', type: 'button', dataset: { kind },
      onClick: () => {
        chatUi(app).menu = null;
        sendOrder(app, squad, { type: 'domestic', kind }, `${t(app, 'cmd.domestic')} ${name}`, { kind: name });
      },
    }, h('span', { class: 'chat-opt__name' }, name));
  });
  return subPanel(app, 'chat.domesticTitle', h('div', { class: 'chat-sub__grid' }, buttons));
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
// 指示を送る（成否はエンジンの queue が決める）
// ------------------------------------------------------------

function sendOrder(app, squad, order, myText, vars = {}) {
  const hero = heroOf(app, squad);
  pushMsg(app, squad.id, 'me', myText);
  const r = queue(app.state, app.db, squad.id, order);
  if (r.ok) {
    pushMsg(app, squad.id, 'hero', say(app.db, hero, `order.${order.type}.ack`, vars));
    persist(app);
  } else if (SPEECH_REJECTS.has(r.reason)) {
    const rv = r.reason === 'ap' ? { ap: squad.ap } : r.reason === 'build' ? { kind: vars.kind } : {};
    pushMsg(app, squad.id, 'hero', say(app.db, hero, `order.reject.${r.reason}`, rv));
  } else {
    pushMsg(app, squad.id, 'sys', t(app, `chat.reject.${r.reason}`));
  }
  rerender();
  return r;
}

function persist(app) {
  try { save(app.state); } catch (e) { console.error(e); }
}
