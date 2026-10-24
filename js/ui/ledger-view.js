// ledger-view.js — 内訳シート（SPEC-114 §3）と、ホーム・内訳で共通の「見込み」の取り出し方
//
// 数字はすべてエンジンの関数から取る（economy.breakdown / forecast / previewDomestic / previewRation / setRation /
// domestic / rest、morale.planNight、heroes.troopCap）。UI は並べて、足し算で「このあと」を出すだけ。
//   ・内訳の行は breakdown の値をそのまま出す（行の合計は必ず差し引きに一致する。0 の行はエンジンが入れない）
//   ・「積んだ指示のあと」は 2 通り:
//       queuedPerDay … 積んだ内政を 1 つずつ previewDomestic にかけて perDay を足す（Chat の「このあと」と同じ足し方）
//       plannedState … 積んだ内政・休息を economy.domestic / rest で写しに当てたもの。forecast(写し) が
//                      「指示のあとで今夜を迎えたら」の見込み（今夜尽きるか・今夜逃げる兵）になる
// ゲームのルールはここに書かない。

import { h, clear, heroImg } from './h.js';
import { uiText } from '../engine/lines.js';
import { breakdown, forecast, previewDomestic, previewRation, setRation, domestic, rest, RATION_KINDS } from '../engine/economy.js';
import { planNight, moraleOf, rationOf, moraleMult, MORALE_SHAKEN, MORALE_DELTA, RATIONS, DESERT_RATE } from '../engine/morale.js';
import { troopCap, musterCap } from '../engine/heroes.js';
import { REGROUP_RATE } from '../engine/turn.js';
import { openPopup, closePopup, go, render, getApp } from '../main.js';
import * as fx from './fx.js';

const HAS_DOM = typeof document !== 'undefined';

/** 増減の記号（画面の中で揃える。マイナスは U+2212） */
export const MINUS = '−';

/** 内訳シートのタブ（この順） */
export const LEDGER_TABS = ['food', 'gum', 'mat', 'pop', 'troops'];

/** 「あと N 日」の黄と赤の境目（SPEC-114 §2.2） */
export const DAYS_WARN = 5;
export const DAYS_BAD = 2;
/** シーズンの最終日（これより後に尽きるなら出さない） */
const LAST_DAY = 28;

/** UI 文言（{n} などを差し込む） */
export function L(app, key, vars = {}) {
  return uiText(app.db, key).replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? m : String(vars[k])));
}

/** +N / −N / ±0 */
export function signed(n) {
  const v = Math.round(n || 0);
  return v > 0 ? `+${v.toLocaleString('ja-JP')}` : v < 0 ? `${MINUS}${(-v).toLocaleString('ja-JP')}` : '±0';
}

/** 1,234 */
export function fmt(n) {
  return Math.floor(n || 0).toLocaleString('ja-JP');
}

function heroOf(app, squad) {
  return app.db.heroes[squad.heroId] || app.db.heroes[String(squad.heroId)] || null;
}

function mySquads(app) {
  const st = app.state;
  return Object.values(st.squads || {})
    .filter((s) => s.land === st.playerLand)
    .sort((a, b) => String(a.id).localeCompare(String(b.id), 'en', { numeric: true }));
}

// ------------------------------------------------------------
// 見込みの取り出し（エンジンの関数を呼ぶだけ）
// ------------------------------------------------------------

/**
 * 積んだ内政の見込みを足したもの（Chat の「このあと」と同じ足し方）。
 * 指示を積んだ順（エンジンの queuedSim と同じ、部隊の並び → 指示の順）に、それまでの指示だけを積んだ写しで
 * previewDomestic を呼び、perDay.food と delta.gum を足す。
 * @returns {{food:number, gum:number, count:number, kinds:Object<string,number>}}
 */
export function queuedPerDay(app, landId = app.state.playerLand) {
  const st = app.state;
  const squads = { ...st.squads };
  const mine = Object.values(st.squads).filter((s) => s.land === landId);
  for (const s of mine) squads[s.id] = { ...s, orders: [] };
  const sim = { ...st, squads };
  const out = { food: 0, gum: 0, count: 0, kinds: {} };
  for (const s of mine) {
    const c = squads[s.id];
    for (const o of s.orders || []) {
      if (o.type === 'domestic') {
        const p = previewDomestic(sim, app.db, c, o.kind);
        out.food += p.perDay.food;
        out.gum += p.delta.gum;
        out.count += 1;
        out.kinds[o.kind] = (out.kinds[o.kind] || 0) + 1;
      }
      c.orders.push(o);
    }
  }
  return out;
}

/** state の写し（そのランドの資源と部隊だけ複製。economy.domestic / rest が書き換えるのはそこだけ） */
function cloneFor(st, landId) {
  const land = st.lands[landId];
  const lands = { ...st.lands, [landId]: { ...land, res: { ...land.res } } };
  const squads = { ...st.squads };
  for (const s of Object.values(st.squads)) if (s.land === landId) squads[s.id] = { ...s, orders: [...(s.orders || [])] };
  return { ...st, lands, squads };
}

/**
 * 積んだ内政・休息を写しに当てた state（実際の state は変えない）。移動のあとの休息は、移動先で数える。
 * 戦闘・占領・建築の結果は入らない（実行してみないと決まらないため）。
 */
export function plannedState(app, landId = app.state.playerLand) {
  const sim = cloneFor(app.state, landId);
  for (const s of Object.values(sim.squads)) {
    if (s.land !== landId) continue;
    for (const o of s.orders || []) {
      if (o.type === 'move' && Array.isArray(o.path) && o.path.length) s.tile = o.path[o.path.length - 1];
      else if (o.type === 'domestic') domestic(sim, app.db, s, o.kind);
      else if (o.type === 'rest') rest(sim, app.db, s);
    }
    // 夜は移動先で迎える（本拠地の士気・回復は、指示のあとの位置で数える）
  }
  return sim;
}

/**
 * plannedState に、ある部隊の内政をさらに n 回当てたもの（「農作 ×3 で あと何日」を出すため）。
 */
export function plannedWith(app, squadId, kind, n) {
  const sim = plannedState(app);
  const s = sim.squads[squadId];
  if (s) for (let i = 0; i < n; i++) domestic(sim, app.db, s, kind);
  return sim;
}

/**
 * 「あと N 日」のチップ。daysLeft は breakdown / forecast の値（1 = 今夜尽きる）。
 * 28 日目より後に尽きるなら出さない。黄 = 5 日以下、赤 = 2 日以下か今夜。
 * @returns {{level:'warn'|'bad', text:string, days:number}|null}
 */
export function daysChip(app, daysLeft) {
  if (daysLeft == null) return null;
  const day = Math.min(app.state.day, LAST_DAY);
  if (day + daysLeft - 1 > LAST_DAY) return null;
  if (daysLeft > DAYS_WARN) return null;
  const level = daysLeft <= DAYS_BAD ? 'bad' : 'warn';
  const text = daysLeft <= 1 ? L(app, 'ledger.tonight') : L(app, 'ledger.daysLeft', { n: daysLeft });
  return { level, text, days: daysLeft };
}

/**
 * ホームと内訳で使う見込みの束。
 *   base … breakdown（積んだ指示を含まない。内訳の行と同じ数）
 *   fc   … forecast（いまの兵・士気）
 *   plan … forecast(plannedState)（指示のあとで今夜を迎えたら。今夜尽きるか・今夜逃げる兵）
 *   after… queuedPerDay（積んだ内政の perDay の合計）
 */
export function outlook(app) {
  const st = app.state;
  const me = st.playerLand;
  const base = breakdown(st, app.db, me);
  const fc = forecast(st, app.db, me);
  const sim = plannedState(app);
  const plan = forecast(sim, app.db, me);
  const after = queuedPerDay(app);
  const tonight = plan.food.daysLeft === 1;
  // 指示のあとで今夜を迎えたら（士気の毎日の変化・逃走）。forecast と同じ「飢えるか」（今夜尽きる）で planNight に聞く
  const night = planNight(sim, app.db, me, tonight, 0);
  return {
    base, fc, plan, after, sim, night,
    foodAfter: base.food.net + after.food,
    tonight,
    // 指示のあとの食料の残り（農作は積んだ時点で写しに足してある）
    foodStock: Math.floor(sim.lands[me].res.food || 0),
    desert: { total: night.desert.reduce((a, d) => a + d.amount, 0), squads: night.desert.length },
  };
}

/**
 * 配給をその値にしたら、食料の差し引きと「あと N 日」がどうなるか（積んだ指示のあとの写しで breakdown に聞く。
 * previewRation と同じ差し替え方。daysLeft はエンジンの値）
 * @returns {{net:number, daysLeft:number|null}}
 */
export function rationOutlook(app, ration, sim = plannedState(app)) {
  const me = app.state.playerLand;
  const land = sim.lands[me];
  const b = breakdown({ ...sim, lands: { ...sim.lands, [me]: { ...land, ration } } }, app.db, me).food;
  return { net: b.net, daysLeft: b.daysLeft };
}

// ------------------------------------------------------------
// 内訳シート
// ------------------------------------------------------------

const ROW_GO = {
  terrain: () => go('map'),
  town: () => go('map'),
};

function rowGo(row) {
  if (row.squad) return () => go('chat', { squad: row.squad });
  if (String(row.key).startsWith('facility.')) return () => go('map');
  return ROW_GO[row.key] || null;
}

function rowEl(app, row, sign) {
  const sq = row.squad ? app.state.squads[row.squad] : null;
  const hero = sq ? heroOf(app, sq) : null;
  const label = row.key === 'troops' ? L(app, 'ledger.squadRow', { name: row.label }) : row.label;
  const value = sign * row.value;
  const act = rowGo(row);
  const body = [
    hero ? heroImg(hero, { class: 'ledger-row__face pixel' }) : h('span', { class: ['ledger-row__dot', `is-${sign > 0 ? 'in' : 'out'}`], 'aria-hidden': 'true' }),
    h('span', { class: 'ledger-row__label' }, label),
    h('span', { class: ['ledger-row__val', 'num', value > 0 ? 'is-up' : value < 0 ? 'is-down' : null], dataset: { v: value } }, signed(value)),
    act ? h('span', { class: 'ledger-row__go', 'aria-hidden': 'true' }) : null,
  ];
  return h('li', { class: 'ledger-row', dataset: { key: row.key } },
    act ? h('button', { class: 'ledger-row__btn', type: 'button', onClick: act }, body) : h('div', { class: 'ledger-row__btn is-static' }, body));
}

function section(app, title, rows, sign, emptyKey) {
  const total = rows.reduce((a, r) => a + r.value, 0) * sign;
  return h('section', { class: ['ledger-sec', sign > 0 ? 'is-in' : 'is-out'] },
    h('h3', { class: 'ledger-sec__title' },
      h('span', null, title),
      h('span', { class: ['num', 'ledger-sec__sum', total > 0 ? 'is-up' : total < 0 ? 'is-down' : null] }, signed(total))),
    rows.length
      ? h('ul', { class: 'ledger-rows' }, rows.map((r) => rowEl(app, r, sign)))
      : h('p', { class: 'ledger-sec__empty muted' }, L(app, emptyKey)));
}

function headOf(app, k, b) {
  // 食料の残高が 0 なら、もう尽きている（「今夜尽きる」ではなく、毎晩の罰）
  const chip = k === 'pop' ? null
    : k === 'food' && b.stock <= 0 && b.net < 0 ? { level: 'bad', text: L(app, 'homeF.w.starving', { v: signed(MORALE_DELTA.starve) }) }
      : daysChip(app, b.daysLeft);
  return h('div', { class: 'ledger-head' },
    h('div', { class: 'ledger-head__stock' },
      h('span', { class: 'ledger-head__label' }, L(app, 'ledger.stock')),
      h('strong', { class: 'ledger-head__val num' }, fmt(b.stock)),
      b.cap != null ? h('span', { class: 'ledger-head__cap num' }, ` / ${fmt(b.cap)}`) : null),
    h('div', { class: 'ledger-head__net' },
      h('span', { class: 'ledger-head__label' }, L(app, 'ledger.net')),
      h('strong', { class: ['ledger-head__nv', 'num', b.net > 0 ? 'is-up' : b.net < 0 ? 'is-down' : null], dataset: { net: b.net } }, `${signed(b.net)}${L(app, 'ledger.perDay')}`)),
    chip ? h('span', { class: ['days-chip', `is-${chip.level}`, 'num'] }, chip.text) : null);
}

/** 食料のタブの配給の切り替え（選ぶ前に previewRation で見込みを出す） */
function rationBox(app, onChange) {
  const st = app.state;
  const me = st.playerLand;
  const cur = rationOf(st.lands[me]);
  const now = breakdown(st, app.db, me).food.net;
  // あと何日（積んだ指示のあとの写しで、配給だけ差し替えて breakdown に聞く）。効かない手は効かないと分かるように
  const sim = plannedState(app);
  const daysNow = rationOutlook(app, cur, sim).daysLeft;
  // 残高 0 なら、もう尽きている（どの配給でも毎晩足りない）
  const empty = Math.floor(sim.lands[me].res.food || 0) <= 0;
  const dw = (d) => (d == null ? L(app, 'homeF.days.enough') : d <= 1 ? L(app, empty ? 'homeF.days.short' : 'ledger.tonight') : L(app, 'ledger.daysLeft', { n: d }));
  return h('section', { class: 'ledger-ration' },
    h('h3', { class: 'ledger-sec__title' }, h('span', null, L(app, 'ledger.ration')), h('span', { class: 'muted ledger-ration__hint' }, L(app, 'ledger.rationHint'))),
    h('div', { class: 'ledger-ration__opts', role: 'radiogroup', 'aria-label': L(app, 'ledger.ration') },
      RATION_KINDS.map((r) => {
        const p = previewRation(st, app.db, me, r);
        const on = r === cur;
        return h('button', {
          class: ['ledger-ration__opt', on ? 'is-on' : null, `is-${r}`], type: 'button', role: 'radio', 'aria-checked': on ? 'true' : 'false',
          dataset: { ration: r, food: p.perDay.food },
          onClick: () => {
            if (on) return;
            setRation(st, me, r);
            onChange();
          },
        },
        h('span', { class: 'ledger-ration__name' }, L(app, `ledger.ration.${r}`)),
        h('span', { class: ['ledger-ration__food', 'num', p.perDay.food < 0 ? 'is-down' : p.perDay.food > 0 ? 'is-up' : null] },
          on ? `${signed(p.perDay.food)}${L(app, 'ledger.perDay')}` : `${signed(now)} → ${signed(p.perDay.food)}`),
        h('span', { class: 'ledger-ration__morale num' },
          p.moralePerDay ? L(app, 'ledger.moralePerDay', { v: signed(p.moralePerDay) }) : L(app, 'ledger.moraleFlat')),
        rationDaysEl(app, on, daysNow, rationOutlook(app, r, sim).daysLeft, dw));
      })));
}

/** 配給の「あと N 日」。選んでいるものは今の値、ほかは「あと 3 日 → あと 3 日（変わらない）」 */
function rationDaysEl(app, on, now, then, dw) {
  if (now == null && then == null) return null;
  if (on) return h('span', { class: 'ledger-ration__days num' }, dw(now));
  const same = now === then;
  return h('span', { class: ['ledger-ration__days', 'num', same ? 'is-same' : null], dataset: { days: then == null ? '' : then } },
    same ? dw(then) : `${dw(now)} → ${dw(then)}`, same ? h('span', { class: 'ledger-ration__same' }, L(app, 'homeF.ledger.same')) : null);
}

/** 積んだ指示のあと（食料・GUM）。積んだ内政が無ければ出さない */
function afterBox(app, k, b) {
  if (k !== 'food' && k !== 'gum') return null;
  const q = queuedPerDay(app);
  if (!q.count) return null;
  const v = k === 'food' ? b.net + q.food : b.net + q.gum;
  if (k === 'gum' && !q.gum) return null;
  const kinds = Object.entries(q.kinds).map(([kind, n]) => `${uiText(app.db, `domestic.${kind}`) === `domestic.${kind}` ? L(app, `ledger.kind.${kind}`) : uiText(app.db, `domestic.${kind}`)} ×${n}`).join('・');
  return h('p', { class: 'ledger-after' },
    h('span', { class: 'ledger-after__label' }, L(app, 'ledger.after', { kinds })),
    h('strong', { class: ['num', v < 0 ? 'is-down' : v > 0 ? 'is-up' : null] }, `${signed(b.net)} → ${signed(v)}${L(app, 'ledger.perDay')}`));
}

function resourceTab(app, k, redraw) {
  const b = breakdown(app.state, app.db, app.state.playerLand)[k];
  const income = section(app, L(app, 'ledger.income'), b.income, 1, 'ledger.noIncome');
  const expense = section(app, L(app, 'ledger.expense'), b.expense, -1, 'ledger.noExpense');
  const sumIn = b.income.reduce((a, r) => a + r.value, 0);
  const sumOut = b.expense.reduce((a, r) => a + r.value, 0);
  return h('div', { class: 'ledger', dataset: { tab: k, net: b.net, check: sumIn - sumOut === b.net ? 'ok' : 'ng' } },
    headOf(app, k, b),
    income, expense,
    h('p', { class: 'ledger-total' },
      h('span', null, L(app, 'ledger.total')),
      h('strong', { class: ['num', b.net > 0 ? 'is-up' : b.net < 0 ? 'is-down' : null] }, `${signed(b.net)}${L(app, 'ledger.perDay')}`)),
    afterBox(app, k, b),
    k === 'food' ? rationBox(app, redraw) : null,
    k === 'food' ? terms(app, ['ration']) : null);
}

/** 士気のゲージ（色だけに頼らず数字と言葉を添える） */
export function moraleGauge(app, m, opts = {}) {
  const level = m === 0 ? 'zero' : m < MORALE_SHAKEN ? 'shaken' : m < 40 ? 'low' : 'ok';
  return h('span', { class: ['morale', `is-${level}`, opts.cls], role: 'img', 'aria-label': `${L(app, 'ledger.morale')} ${m}` },
    h('span', { class: 'morale__bar', 'aria-hidden': 'true' }, h('span', { class: 'morale__fill', style: { width: `${Math.max(0, Math.min(100, m))}%` } })),
    h('span', { class: 'morale__num num', 'aria-hidden': 'true' }, String(m)));
}

const ORDER_KEY = { move: 'ledger.order.move', claim: 'ledger.order.claim', build: 'ledger.order.build', attack: 'ledger.order.attack', rest: 'ledger.order.rest' };

function ordersText(app, s) {
  const list = s.orders || [];
  if (!list.length) return L(app, 'ledger.order.none');
  const counts = [];
  for (const o of list) {
    const label = o.type === 'domestic'
      ? (uiText(app.db, `domestic.${o.kind}`) === `domestic.${o.kind}` ? L(app, `ledger.kind.${o.kind}`) : uiText(app.db, `domestic.${o.kind}`))
      : L(app, ORDER_KEY[o.type] || 'ledger.order.other');
    const last = counts[counts.length - 1];
    if (last && last.label === label) last.n += 1;
    else counts.push({ label, n: 1 });
  }
  return counts.map((c) => (c.n > 1 ? `${c.label} ×${c.n}` : c.label)).join('・');
}

function placeText(app, s) {
  const st = app.state;
  const land = st.lands[st.playerLand];
  if (s.status === 'routed') return L(app, 'ledger.place.routed');
  if (land && s.tile === land.home) return L(app, 'ledger.place.home');
  const t = st.map && st.map.tiles && st.map.tiles[s.tile];
  return t && t.owner === st.playerLand ? L(app, 'ledger.place.own') : L(app, 'ledger.place.away');
}

/**
 * 「定員 400（上限 1,910）・いま戻せる 0（人口）」（SPEC-113 §2.1）。夜の回復・休息で戻せるのは定員まで、
 * 上限（統率力 × 10 の合計）までは徴兵でしか増えない。人口が定員までの空きより少ないときだけ、いま戻せる数を添える
 */
function capText(app, troops, pop) {
  const room = Math.max(0, troops.muster - troops.total);
  const p = Math.max(0, Math.floor(pop || 0));
  const v = { muster: fmt(troops.muster), cap: fmt(troops.cap), n: fmt(p) };
  return p < room ? L(app, 'homeF.ledger.musterPop', v) : L(app, 'homeF.ledger.muster', v);
}

function troopsTab(app) {
  const st = app.state;
  const me = st.playerLand;
  const fc = forecast(st, app.db, me);
  const base = breakdown(st, app.db, me);
  // 指示のあとで今夜を迎えたら（士気の毎日の変化・逃走）。forecast と同じ「飢えるか」の決め方で planNight に聞く
  const sim = plannedState(app);
  const sb = breakdown(sim, app.db, me);
  const night = planNight(sim, app.db, me, sb.food.stock + sb.food.net < 0, 0);
  const tonightMorale = new Map(night.morale.map((x) => [x.squad, x]));
  const tonightDesert = new Map(night.desert.map((x) => [x.squad, x.amount]));
  const foodRow = new Map(base.food.expense.filter((r) => r.key === 'troops').map((r) => [r.squad, r.value]));
  const desertTotal = night.desert.reduce((a, d) => a + d.amount, 0);

  const head = h('div', { class: 'ledger-head ledger-head--troops' },
    h('div', { class: 'ledger-head__stock' },
      h('span', { class: 'ledger-head__label' }, L(app, 'ledger.troops')),
      h('strong', { class: 'ledger-head__val num' }, fmt(fc.troops.total)),
      // 定員と上限（統率力 × 10 の合計）と、いま戻せる数。兵は人口 1 につき 1 しか戻らないので、人口が足りなければ定員に届かない
      h('span', { class: 'ledger-head__cap num' }, capText(app, fc.troops, st.lands[me].res.pop))),
    h('div', { class: 'ledger-head__net' },
      h('span', { class: 'ledger-head__label' }, L(app, 'ledger.moraleAvg')),
      fc.morale.avg == null ? h('strong', { class: 'num' }, '-') : moraleGauge(app, fc.morale.avg, { cls: 'morale--head' })),
    desertTotal > 0 ? h('span', { class: 'days-chip is-bad num' }, L(app, 'ledger.desertTonight', { n: fmt(desertTotal) }))
      : fc.morale.shaken > 0 ? h('span', { class: 'days-chip is-warn num' }, L(app, 'ledger.shakenN', { n: fc.morale.shaken })) : null);

  const rows = mySquads(app).map((s) => {
    const hero = heroOf(app, s);
    const cap = hero ? troopCap(hero, s, app.db) : 0;
    const muster = hero ? musterCap(hero, s, app.db) : 0;
    const m = moraleOf(s);
    const tm = tonightMorale.get(s.id);
    const des = tonightDesert.get(s.id) || 0;
    const food = foodRow.get(s.id) || 0;
    let state = null;
    if (s.status === 'routed') state = { cls: 'is-off', text: L(app, 'ledger.state.routed') };
    else if (des > 0) state = { cls: 'is-bad', text: L(app, 'ledger.state.desert', { n: des }) };
    else if (m === 0) state = { cls: 'is-warn', text: L(app, 'ledger.state.zeroHold') };
    else if (m < MORALE_SHAKEN) state = { cls: 'is-warn', text: L(app, 'ledger.state.shaken') };
    return h('li', { class: 'ledger-squad', dataset: { squad: s.id } },
      h('button', { class: 'ledger-squad__btn', type: 'button', onClick: () => go('chat', { squad: s.id }) },
        hero ? heroImg(hero, { class: 'ledger-squad__face pixel' }) : h('span', { class: 'ledger-squad__face' }),
        h('span', { class: 'ledger-squad__main' },
          h('span', { class: 'ledger-squad__top' },
            h('span', { class: 'ledger-squad__name' }, hero ? hero.name : s.id),
            state ? h('span', { class: ['ledger-squad__state', state.cls] }, state.text) : null),
          h('span', { class: 'ledger-squad__nums' },
            h('span', { class: 'num' }, L(app, 'ledger.troopsMuster', { n: fmt(s.troops || 0), muster: fmt(muster), cap: fmt(cap) })),
            h('span', { class: 'num ledger-squad__food' }, L(app, 'ledger.foodOf', { v: signed(-food) }))),
          h('span', { class: 'ledger-squad__mor' },
            moraleGauge(app, m),
            tm && tm.delta ? h('span', { class: ['num', 'ledger-squad__tonight', tm.delta > 0 ? 'is-up' : 'is-down'] }, L(app, 'ledger.tonightMorale', { v: signed(tm.delta) })) : null),
          h('span', { class: 'ledger-squad__meta' },
            h('span', null, placeText(app, s)),
            h('span', { class: 'ledger-squad__orders' }, ordersText(app, s)))),
        h('span', { class: 'ledger-row__go', 'aria-hidden': 'true' })));
  });
  return h('div', { class: 'ledger ledger--troops', dataset: { tab: 'troops' } },
    head,
    h('ul', { class: 'ledger-squads' }, rows),
    terms(app, ['muster', 'morale', 'desert', 'reward']));
}

/** 用語の文に差し込む値（エンジンの定数。文の中に数を書き写さない） */
function termVars() {
  return {
    shaken: MORALE_SHAKEN, starve: signed(MORALE_DELTA.starve), reward: signed(MORALE_DELTA.reward),
    saveFood: RATIONS.save.food, saveMorale: signed(RATIONS.save.morale), feastFood: RATIONS.feast.food, feastMorale: signed(RATIONS.feast.morale),
    m0: moraleMult(0).toFixed(2), m50: moraleMult(50).toFixed(2), m100: moraleMult(100).toFixed(2), pct: Math.round(DESERT_RATE * 100),
    regroup: Math.round(REGROUP_RATE * 100),
  };
}

/** 用語（定員・士気・配給・恩賞・逃走。SPEC-114 §8・SPEC-113 §2.1） */
function terms(app, ids) {
  return h('details', { class: 'ledger-terms' },
    h('summary', null, L(app, 'ledger.terms')),
    h('dl', null, ids.map((id) => [
      h('dt', null, L(app, `ledger.term.${id}`)),
      h('dd', null, L(app, `ledger.term.${id}.text`, termVars())),
    ])));
}

/**
 * 内訳シートを開く（下から出る）。
 * @param {object} app
 * @param {string} [tab] 'food'|'gum'|'mat'|'pop'|'troops'
 */
export function openLedger(app = getApp(), tab = 'food') {
  if (!HAS_DOM || !app.state) return;
  let cur = LEDGER_TABS.includes(tab) ? tab : 'food';
  const tabs = h('div', { class: 'ledger-tabs', role: 'tablist', 'aria-label': L(app, 'ledger.title') });
  const panel = h('div', { class: 'ledger-panel', role: 'tabpanel' });
  const body = h('div', { class: 'ledger-sheet' }, tabs, panel);
  const draw = (dir = 0) => {
    clear(tabs);
    for (const k of LEDGER_TABS) {
      const on = k === cur;
      tabs.appendChild(h('button', {
        class: ['ledger__tab', on ? 'is-on' : null], type: 'button', role: 'tab', 'aria-selected': on ? 'true' : 'false',
        dataset: { tab: k },
        onClick: () => {
          if (k === cur) return;
          const d = LEDGER_TABS.indexOf(k) > LEDGER_TABS.indexOf(cur) ? 1 : -1;
          cur = k;
          draw(d);
        },
      }, L(app, `ledger.tab.${k}`)));
    }
    clear(panel);
    const el = cur === 'troops' ? troopsTab(app) : resourceTab(app, cur, () => draw(0));
    panel.appendChild(el);
    panel.scrollTop = 0;
    if (dir) fx.slideIn(el, dir, { distance: 24 });
  };
  draw();
  const backdrop = openPopup(body, {
    title: L(app, 'ledger.title'),
    // 配給を変えたなどの変化を、閉じたあとホームにも映す
    onClose: () => setTimeout(() => { if (app.ui.app === 'home' && !app.ui.popup) render(); }, 0),
  });
  if (backdrop) backdrop.classList.add('popup--sheet');
  return backdrop;
}

export { closePopup };
