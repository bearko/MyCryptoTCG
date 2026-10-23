// calendar-view.js — MCH Calendar（SPEC-111 §5・SPEC-112 §5）
//
// 4 週 × 7 日の 28 日。1 週が 1 つの季節なので、行の頭に季節を出す。今日のマスは光り、過ぎた日はグレー。
// 日ごとの予定は種類ごとの色のピン:
//   建築の完成（state.builds の daysLeft と、積んだ build の日数）・移動の到着（積んだ move）・
//   日曜の集計・季節の変わり目・最終日のバッテリー切れ。
// 日付・季節・曜日・バッテリーは season.js に聞く。建築の日数は economy.canBuild、AP の上限は orders.apMax に聞く。
// 日をタップすると、そのマスが広がって下の詳細になる（app.ui.calDay）。

import { h } from './h.js';
import { uiText } from '../engine/lines.js';
import { dayOfWeek, seasonOf, weekOf, battery, SEASON_DAYS } from '../engine/season.js';
import { canBuild } from '../engine/economy.js';
import { apMax } from '../engine/orders.js';
import { go } from '../main.js';
import { appHead, helpPopup, entering, leave, tx } from './app-kit.js';
import * as fx from './fx.js';

const t = (app, key) => uiText(app.db, key);
const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? m : String(vars[k])));

/** ピンの種類（凡例とヘルプの順） */
const KINDS = ['build', 'arrive', 'week', 'season', 'battery'];
/** 1 マスに並べるピンの数（超えたら +n） */
const PINS_MAX = 3;
/** これからの予定に並べる数 */
const UPCOMING_MAX = 4;

function heroOf(db, squad) {
  return db.heroes[squad.heroId] || db.heroes[String(squad.heroId)] || null;
}

function facilityName(app, kind) {
  const key = `facility.${kind}`;
  const s = t(app, key);
  if (s !== key) return s;
  const def = app.db.facilities && app.db.facilities[kind];
  return def ? def.name : kind;
}

function terrainName(app, tileIdx) {
  const tile = app.state.map.tiles[tileIdx];
  if (!tile) return '';
  const key = `terrain.${tile.terrain}`;
  const s = t(app, key);
  return s !== key ? s : tile.terrain;
}

/**
 * 28 日ぶんの予定を集める。{ [day]: Item[] }。Item = { kind, text, tile?, hero? }
 * 判定（日数・季節・曜日）は engine の関数の結果を並べるだけ。
 */
export function scheduleOf(app) {
  const st = app.state;
  const db = app.db;
  const days = {};
  const add = (d, item) => {
    if (d < 1 || d > SEASON_DAYS) return;
    (days[d] || (days[d] = [])).push(item);
  };

  // 季節の変わり目・日曜の集計・バッテリー切れ
  for (let d = 1; d <= SEASON_DAYS; d++) {
    if (d > 1 && seasonOf(d) !== seasonOf(d - 1)) {
      add(d, { kind: 'season', text: `${t(app, 'calendar.seasonChange')}（${t(app, `season.${seasonOf(d)}`)}）` });
    }
    if (dayOfWeek(d) === 6) {
      add(d, { kind: 'week', text: `${fill(t(app, 'calendar.week'), { n: weekOf(d) })} ${t(app, 'calendar.weekEnd')}` });
    }
    if (battery(d) > 0 && battery(d + 1) === 0) {
      add(d, { kind: 'battery', text: t(app, 'calendar.batteryOut') });
    }
  }

  const today = Math.min(st.day, SEASON_DAYS);

  // 建築中（自分のランド）。tickBuilds はその日の終わりに 1 減らすので、daysLeft 日目の終わりに完成する
  for (const b of Object.values(st.builds || {})) {
    if (b.land !== st.playerLand) continue;
    add(today + Math.max(1, b.daysLeft) - 1, {
      kind: 'build', tile: b.tileIdx,
      text: `${t(app, 'calendar.buildDone')}：${facilityName(app, b.kind)} ${t(app, 'facility.rank')}${b.toRank}`,
    });
  }

  // 積んだ指示（自分の部隊）
  for (const sq of Object.values(st.squads || {})) {
    if (sq.land !== st.playerLand) continue;
    const hero = heroOf(db, sq);
    if (!hero) continue;
    const max = Math.max(1, apMax(hero, { ...sq, ambushed: false, status: 'ok' }, db));
    let spent = 0;
    let lastMove = null;
    let tile = sq.tile;
    for (const o of sq.orders || []) {
      spent += Number(o.ap) || 0;
      if (o.type === 'move' && Array.isArray(o.path) && o.path.length) {
        tile = o.path[o.path.length - 1];
        lastMove = { tile, spent };
      } else if (o.type === 'build') {
        const chk = canBuild(st, db, sq.land, tile, o.kind, sq);
        const d = Math.max(1, chk.days - Math.max(0, Math.floor(o.rush || 0)));
        // 着工は積んだ AP を使い切った日。その日の終わりから数えて d 日目の終わりに完成
        add(today + Math.max(1, Math.ceil(spent / max)) - 1 + d - 1, {
          kind: 'build', tile, hero,
          text: `${t(app, 'calendar.buildDone')}：${facilityName(app, o.kind)}（${hero.name}）`,
        });
      }
    }
    if (lastMove) {
      const need = Math.max(1, Math.ceil(lastMove.spent / max));
      add(today + need - 1, {
        kind: 'arrive', tile: lastMove.tile, hero,
        text: `${t(app, 'calendar.arrive')}：${hero.name} → ${terrainName(app, lastMove.tile)}`,
      });
    }
  }
  return days;
}

function pin(kind, extra) {
  return h('span', { class: ['cal-pin', `cal-pin--${kind}`, extra] });
}

function dayCell(app, d, items, selected) {
  const st = app.state;
  const today = Math.min(st.day, SEASON_DAYS);
  const past = d < today;
  const isToday = d === today;
  const kinds = [...new Set(items.map((i) => i.kind))];
  const label = `${t(app, 'status.day')} ${d}${isToday ? `（${t(app, 'calendar.today')}）` : ''}${items.length ? ` ${items.length}件` : ''}`;
  return h('button', {
    class: ['cal-day', past ? 'is-past' : null, isToday ? 'is-today' : null, selected ? 'is-selected' : null,
      dayOfWeek(d) === 6 ? 'is-sunday' : null, items.length ? 'has-items' : null],
    type: 'button', role: 'gridcell', 'aria-label': label, 'aria-selected': selected ? 'true' : 'false',
    dataset: { day: d, season: seasonOf(d) }, style: { '--c': String(dayOfWeek(d)), '--r': String(weekOf(d) - 1) },
    onClick: (e) => pickDay(app, d, e.currentTarget),
  },
  isToday ? h('span', { class: 'cal-day__ring', 'aria-hidden': 'true' }) : null,
  h('span', { class: 'cal-day__no num' }, String(d)),
  isToday ? h('span', { class: 'cal-day__today' }, t(app, 'calendar.today')) : null,
  h('span', { class: 'cal-day__pins', 'aria-hidden': 'true' },
    kinds.slice(0, PINS_MAX).map((k, i) => pin(k, null, i)),
    kinds.length > PINS_MAX ? h('span', { class: 'cal-day__more num' }, `+${kinds.length - PINS_MAX}`) : null));
}

function dayList(app, d, items) {
  const today = Math.min(app.state.day, SEASON_DAYS);
  const rel = d === today ? t(app, 'calendar.today') : d > today ? fill(tx(app, 'calendar.inDays', 'あと {n} 日'), { n: d - today }) : fill(tx(app, 'calendar.daysAgo', '{n} 日前'), { n: today - d });
  const head = h('header', { class: 'cal-list__head' },
    h('span', { class: 'cal-list__date' },
      h('span', { class: 'cal-list__no num' }, String(d)),
      h('span', { class: 'cal-list__dow' }, t(app, `dow.${dayOfWeek(d)}`))),
    h('h2', { class: 'cal-list__title', id: 'cal-list-title' },
      h('span', null, `${t(app, 'status.day')} ${d}`),
      h('span', { class: 'cal-list__sub' }, `${t(app, `season.${seasonOf(d)}`)} ・ ${rel}`)),
    h('span', { class: 'cal-list__battery num', dataset: { low: battery(d) <= 20 ? '1' : null } },
      h('span', { class: 'cal-list__battery-icon', style: { '--b': String(battery(d) / 100) }, 'aria-hidden': 'true' }), `${battery(d)}%`));
  const sec = (body) => h('section', { class: ['cal-list', d === today ? 'is-today' : null], 'aria-labelledby': 'cal-list-title', dataset: { day: d } }, head, body);
  if (!items.length) return sec(h('p', { class: 'empty muted cal-list__empty' }, t(app, 'calendar.empty')));
  return sec(h('ul', { class: 'cal-items' }, items.map((it) => h('li', { class: `cal-item cal-item--${it.kind}` },
    it.tile != null
      ? h('button', { class: 'cal-item__btn', type: 'button', onClick: () => go('map', { tile: it.tile }) },
        pin(it.kind, 'cal-pin--big'), h('span', { class: 'cal-item__text' }, it.text),
        h('span', { class: 'cal-item__go' }, t(app, 'app.map').replace(/^MCH /, '')))
      : h('div', { class: 'cal-item__btn' },
        pin(it.kind, 'cal-pin--big'), h('span', { class: 'cal-item__text' }, it.text))))));
}

/** これからの予定（今日から先の 4 件）。押すとその日を開く */
function upcoming(app, sched) {
  const today = Math.min(app.state.day, SEASON_DAYS);
  const list = [];
  for (let d = today; d <= SEASON_DAYS && list.length < UPCOMING_MAX; d++) {
    for (const it of sched[d] || []) if (list.length < UPCOMING_MAX) list.push({ d, it });
  }
  if (!list.length) return null;
  return h('section', { class: 'cal-next', 'aria-labelledby': 'cal-next-title' },
    h('h2', { class: 'section-title', id: 'cal-next-title' }, tx(app, 'calendar.upcoming', 'これからの予定')),
    h('ol', { class: 'cal-next__list' }, list.map(({ d, it }) => h('li', { class: `cal-next__item cal-item--${it.kind}` },
      h('button', {
        class: ['cal-next__btn', d === app.ui.calDay ? 'is-open' : null], type: 'button',
        onClick: (e) => pickDay(app, d, e.currentTarget),
      },
      h('span', { class: 'cal-next__day num' }, h('b', null, String(d)), h('small', null, d === today ? t(app, 'calendar.today') : fill(tx(app, 'calendar.inDays', 'あと {n} 日'), { n: d - today }))),
      pin(it.kind, 'cal-pin--big'),
      h('span', { class: 'cal-next__text' }, it.text))))));
}

function openHelp(app) {
  helpPopup(app, {
    title: tx(app, 'help.calendarTitle', 'カレンダーの見かた'),
    lead: tx(app, 'help.calendarLead', ''),
    items: KINDS.map((k) => ({ id: k, term: t(app, `calendar.legend.${k}`), text: t(app, `help.calendar.${k}`), tag: pin(k, 'cal-pin--big') })),
  });
}

let rootEl = null;
/** 開いた日のマス（広がる動きの起点） */
let openFrom = null;

function build(app) {
  const st = app.state;
  const today = Math.min(st.day, SEASON_DAYS);
  if (!app.ui.calDay || app.ui.calDay < 1 || app.ui.calDay > SEASON_DAYS) app.ui.calDay = today;
  const sel = app.ui.calDay;
  const sched = scheduleOf(app);

  const head = h('div', { class: 'cal-dow', role: 'row' },
    h('span', { class: 'cal-dow__cell cal-dow__cell--season', role: 'columnheader' }, h('span', { class: 'sr-only' }, tx(app, 'calendar.seasonCol', '季節'))),
    [0, 1, 2, 3, 4, 5, 6].map((i) => h('span', { class: ['cal-dow__cell', i === 6 ? 'is-sunday' : null], role: 'columnheader' }, t(app, `dow.${i}`))));
  // 1 週 = 1 行 = 1 季節（1 日目は月曜。28 日 = 4 週ぴったり）
  const weeks = [];
  for (let w = 0; w < SEASON_DAYS / 7; w++) {
    const first = w * 7 + 1;
    const season = seasonOf(first);
    const cur = weekOf(today) === w + 1;
    const cells = [];
    for (let d = first; d < first + 7; d++) cells.push(dayCell(app, d, sched[d] || [], d === sel));
    weeks.push(h('div', { class: ['cal-week', cur ? 'is-current' : null, weekOf(today) > w + 1 ? 'is-done' : null], role: 'row', dataset: { season } },
      h('span', { class: 'cal-week__season', role: 'rowheader' },
        h('span', { class: 'cal-week__name' }, t(app, `season.${season}`)),
        h('span', { class: 'cal-week__no num' }, `W${w + 1}`)),
      cells));
  }
  const prog = (today - 1) / (SEASON_DAYS - 1);

  return h('section', { class: 'app-screen app-screen--calendar cal' },
    appHead(app, { title: t(app, 'app.calendar'), sub: h('span', { class: 'num' }, `${t(app, 'calendar.today')} ${t(app, 'status.day')} ${today} / ${SEASON_DAYS}`), help: () => openHelp(app), back: () => go('home') }),
    h('div', { class: 'cal-progress', 'aria-hidden': 'true', style: { '--p': String(prog) } },
      h('span', { class: 'cal-progress__fill' }), h('span', { class: 'cal-progress__head' })),
    h('div', { class: 'cal-grid-wrap' },
      head,
      h('div', { class: 'cal-grid', role: 'grid', 'aria-label': t(app, 'calendar.title') }, weeks)),
    h('div', { class: 'cal-legend', 'aria-hidden': 'true' },
      KINDS.map((k) => h('span', { class: 'cal-legend__item' }, pin(k), t(app, `calendar.legend.${k}`)))),
    dayList(app, sel, sched[sel] || []),
    upcoming(app, sched));
}

/** 日を選ぶ: 選んだマスが広がって、下の詳細になる */
function pickDay(app, d, cell) {
  if (app.ui.calDay === d) {
    // 同じ日をもう一度: 詳細を軽く弾ませて「ここに出ている」と知らせる
    const list = rootEl && rootEl.querySelector('.cal-list');
    if (list && list.animate && !fx.reducedMotion()) list.animate([{ transform: 'scale(.98)' }, { transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.34, 1.56, .64, 1)' });
    return;
  }
  app.ui.calDay = d;
  openFrom = cell && cell.getBoundingClientRect ? cell.getBoundingClientRect() : null;
  redraw(app);
}

function redraw(app) {
  if (!rootEl || !rootEl.parentNode) return;
  const fresh = build(app);
  rootEl.parentNode.replaceChild(fresh, rootEl);
  rootEl = fresh;
  const btn = fresh.querySelector('.cal-day.is-selected');
  if (btn) btn.focus({ preventScroll: true });
  if (openFrom) expandFrom(fresh, openFrom);
  openFrom = null;
}

/** マスの位置から、詳細の大きさへ光る板が広がり、中身が順に出る */
function expandFrom(root, from) {
  const list = root.querySelector('.cal-list');
  const cell = root.querySelector('.cal-day.is-selected');
  if (cell && cell.animate && !fx.reducedMotion()) {
    cell.animate([{ transform: 'scale(.86)' }, { transform: 'scale(1.08)', offset: 0.55 }, { transform: 'none' }], { duration: 360, easing: 'cubic-bezier(.34, 1.56, .64, 1)' });
  }
  if (!list || fx.reducedMotion() || !list.animate) return;
  const to = list.getBoundingClientRect();
  const ms = fx.token('--t-ui', 240) * 1.6;
  const plate = h('div', { class: 'cal-zoom', 'aria-hidden': 'true' });
  plate.style.left = `${to.left}px`;
  plate.style.top = `${to.top}px`;
  plate.style.width = `${to.width}px`;
  plate.style.height = `${to.height}px`;
  document.body.appendChild(plate);
  const sx = from.width / to.width;
  const sy = from.height / to.height;
  plate.animate([
    { transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${sx}, ${sy})`, opacity: 1 },
    { transform: 'none', opacity: 0.9, offset: 0.7 },
    { transform: 'none', opacity: 0 },
  ], { duration: ms, easing: 'cubic-bezier(.2, .8, .2, 1)', fill: 'forwards' }).finished.then(() => plate.remove(), () => plate.remove());
  list.animate([{ opacity: 0, transform: 'translateY(-6px) scale(.97)' }, { opacity: 0, offset: 0.35 }, { opacity: 1, transform: 'none' }], { duration: ms, easing: 'cubic-bezier(.16, 1, .3, 1)' });
  fx.stagger(list.querySelectorAll('.cal-item, .cal-list__empty'), { step: 55, delay: ms * 0.45, from: 'left', distance: 12 });
}

export function render(app) {
  rootEl = build(app);
  return rootEl;
}

export function mount(app, el) {
  if (!el || !entering('calendar') || fx.reducedMotion()) return;
  // 入ってきたときだけ、マスが週ごとに順に並び、今日が光る
  el.classList.add('is-enter');
  setTimeout(() => el.classList.remove('is-enter'), 1300);
  fx.stagger(el.querySelectorAll('.cal-items > .cal-item'), { step: 50, delay: 380, from: 'left', distance: 10 });
  fx.stagger(el.querySelectorAll('.cal-next__item'), { step: 60, delay: 520, from: 'up', distance: 10 });
}

export function unmount(app) {
  rootEl = null;
  openFrom = null;
  if (app && app.ui.app !== 'calendar') leave('calendar');
}
