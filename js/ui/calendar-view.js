// calendar-view.js — MCH Calendar（SPEC-111 §5）
//
// 7 列 × 4 行の 28 日。今日を強調し、過ぎた日はグレー。日ごとの予定:
//   建築の完成（state.builds の daysLeft と、積んだ build の日数）・移動の到着（積んだ move）・
//   日曜の集計・季節の変わり目・最終日のバッテリー切れ。
// 日付・季節・曜日・バッテリーは season.js に聞く。建築の日数は economy.canBuild、AP の上限は orders.apMax に聞く。
// 日をタップすると、その日の予定を下に並べる（app.ui.calDay）。

import { h } from './h.js';
import { uiText } from '../engine/lines.js';
import { dayOfWeek, seasonOf, weekOf, battery, SEASON_DAYS } from '../engine/season.js';
import { canBuild } from '../engine/economy.js';
import { apMax } from '../engine/orders.js';
import { go } from '../main.js';

const t = (app, key) => uiText(app.db, key);
const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? m : String(vars[k])));

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
 * 28 日ぶんの予定を集める。{ [day]: Item[] }。Item = { kind, text, tile? }
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
          kind: 'build', tile,
          text: `${t(app, 'calendar.buildDone')}：${facilityName(app, o.kind)}（${hero.name}）`,
        });
      }
    }
    if (lastMove) {
      const need = Math.max(1, Math.ceil(lastMove.spent / max));
      add(today + need - 1, {
        kind: 'arrive', tile: lastMove.tile,
        text: `${t(app, 'calendar.arrive')}：${hero.name} → ${terrainName(app, lastMove.tile)}`,
      });
    }
  }
  return days;
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
      dayOfWeek(d) === 6 ? 'is-sunday' : null],
    type: 'button', role: 'gridcell', 'aria-label': label, 'aria-selected': selected ? 'true' : 'false',
    dataset: { day: d, season: seasonOf(d) },
    onClick: () => { app.ui.calDay = d; redraw(app); },
  },
  h('span', { class: 'cal-day__no num' }, String(d)),
  h('span', { class: 'cal-day__dots', 'aria-hidden': 'true' }, kinds.map((k) => h('span', { class: `cal-dot cal-dot--${k}` }))));
}

function dayList(app, d, items) {
  const head = h('h2', { class: 'section-title', id: 'cal-list-title' },
    `${t(app, 'status.day')} ${d}（${t(app, `dow.${dayOfWeek(d)}`)}・${t(app, `season.${seasonOf(d)}`)}）`);
  if (!items.length) {
    return h('section', { class: 'cal-list', 'aria-labelledby': 'cal-list-title' }, head,
      h('p', { class: 'empty muted' }, t(app, 'calendar.empty')));
  }
  return h('section', { class: 'cal-list', 'aria-labelledby': 'cal-list-title' }, head,
    h('ul', { class: 'cal-items' }, items.map((it) => h('li', { class: `cal-item cal-item--${it.kind}` },
      it.tile != null
        ? h('button', { class: 'cal-item__btn', type: 'button', onClick: () => go('map', { tile: it.tile }) },
          h('span', { class: `cal-dot cal-dot--${it.kind}`, 'aria-hidden': 'true' }), h('span', null, it.text),
          h('span', { class: 'cal-item__go' }, t(app, 'app.map').replace(/^MCH /, '')))
        : h('div', { class: 'cal-item__btn' },
          h('span', { class: `cal-dot cal-dot--${it.kind}`, 'aria-hidden': 'true' }), h('span', null, it.text))))));
}

let rootEl = null;

function build(app) {
  const st = app.state;
  const today = Math.min(st.day, SEASON_DAYS);
  if (!app.ui.calDay || app.ui.calDay < 1 || app.ui.calDay > SEASON_DAYS) app.ui.calDay = today;
  const sel = app.ui.calDay;
  const sched = scheduleOf(app);

  const head = h('div', { class: 'cal-dow', role: 'row' },
    [0, 1, 2, 3, 4, 5, 6].map((i) => h('span', { class: ['cal-dow__cell', i === 6 ? 'is-sunday' : null], role: 'columnheader' }, t(app, `dow.${i}`))));
  // 1 日目の曜日から並べる（28 日 = 4 週ぴったり）
  const offset = dayOfWeek(1);
  const cells = [];
  for (let i = 0; i < offset; i++) cells.push(h('span', { class: 'cal-day cal-day--blank', 'aria-hidden': 'true' }));
  for (let d = 1; d <= SEASON_DAYS; d++) cells.push(dayCell(app, d, sched[d] || [], d === sel));

  return h('section', { class: 'app-screen app-screen--calendar cal' },
    h('header', { class: 'app-head' },
      h('h1', { class: 'app-title' }, t(app, 'app.calendar')),
      h('span', { class: 'app-head__sub muted num' }, `${t(app, 'calendar.today')} ${t(app, 'status.day')} ${today}`)),
    h('div', { class: 'cal-grid-wrap' },
      head,
      h('div', { class: 'cal-grid', role: 'grid', 'aria-label': t(app, 'calendar.title') }, cells)),
    h('div', { class: 'cal-legend muted', 'aria-hidden': 'true' },
      ['build', 'arrive', 'week', 'season', 'battery'].map((k) => h('span', { class: 'cal-legend__item' },
        h('span', { class: `cal-dot cal-dot--${k}` }), t(app, `calendar.legend.${k}`)))),
    dayList(app, sel, sched[sel] || []));
}

function redraw(app) {
  if (!rootEl || !rootEl.parentNode) return;
  const fresh = build(app);
  rootEl.parentNode.replaceChild(fresh, rootEl);
  rootEl = fresh;
  const btn = fresh.querySelector('.cal-day.is-selected');
  if (btn) btn.focus();
}

export function render(app) {
  rootEl = build(app);
  return rootEl;
}

export function unmount() {
  rootEl = null;
}
