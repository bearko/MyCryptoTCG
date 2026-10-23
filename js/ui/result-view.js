// result-view.js — 結果（SPEC-111 §9）
//
// 理由・9 ランドの砦ポイント順位・season.score の内訳（数字が転がる。1.5 秒以内）・もう一度。
// 点の計算は season.score に聞く（ここでは足し算もしない）。

import { h, imgEl, landAssetPath, reducedMotion } from './h.js';
import { uiText } from '../engine/lines.js';
import { score, tileCount } from '../engine/season.js';
import { restart } from '../main.js';

const ROLL_MS = 1200;
const BREAKDOWN_KEYS = ['fortPoints', 'tiles', 'heroes', 'facilities', 'clear', 'daysLeft'];

let rafs = [];

function landDef(app, id) {
  return (app.db.lands || []).find((l) => l.id === id) || { id, nameJa: id, name: id, color: '#8c7fb0' };
}

function rankLands(app) {
  const st = app.state;
  return (app.db.lands || [])
    .filter((l) => st.lands[l.id])
    .map((l) => ({ def: l, land: st.lands[l.id], fp: st.lands[l.id].fortPoints || 0, tiles: tileCount(st, l.id) }))
    .sort((a, b) => b.fp - a.fp || b.tiles - a.tiles);
}

export function render(app) {
  const st = app.state;
  const db = app.db;
  const ended = st.ended || { reason: 'season', winner: null };
  const sc = score(st, db, st.playerLand);
  const winner = ended.winner ? landDef(app, ended.winner) : null;
  const won = ended.winner === st.playerLand;

  const rows = BREAKDOWN_KEYS.map((k) => h('div', { class: 'score-row' },
    h('dt', null, uiText(db, `result.bd.${k}`)),
    h('dd', { class: 'num roll', dataset: { to: sc.breakdown[k] || 0 } }, '0')));

  const ranking = rankLands(app);
  return h('section', { class: ['result', won ? 'is-win' : null] },
    h('header', { class: 'result__head' },
      h('h1', { class: 'result__title' }, uiText(db, 'result.title')),
      h('p', { class: 'result__reason' },
        h('span', { class: 'muted' }, uiText(db, 'result.reason')), ' ',
        h('strong', null, uiText(db, `end.${ended.reason}`))),
      winner ? h('p', { class: 'result__winner', style: { '--land': winner.color } },
        h('span', { class: 'muted' }, uiText(db, 'result.winner')), ' ',
        h('strong', null, winner.nameJa || winner.name)) : null),
    h('section', { class: 'result__score', 'aria-labelledby': 'result-score-title' },
      h('h2', { class: 'section-title', id: 'result-score-title' }, uiText(db, 'result.score')),
      h('dl', { class: 'score-list' }, rows,
        h('div', { class: 'score-row score-row--total' },
          h('dt', null, uiText(db, 'result.total')),
          h('dd', { class: 'num roll', dataset: { to: sc.total } }, '0')))),
    h('section', { class: 'result__rank', 'aria-labelledby': 'result-rank-title' },
      h('h2', { class: 'section-title', id: 'result-rank-title' }, uiText(db, 'result.rank')),
      h('ol', { class: 'rank-list' }, ranking.map((r, i) => h('li', {
        class: ['rank-row', r.def.id === st.playerLand ? 'is-me' : null, r.land.alive === false ? 'is-out' : null],
        style: { '--land': r.def.color },
      },
      h('span', { class: 'rank-row__no num' }, String(i + 1)),
      imgEl(landAssetPath(r.def.icon), r.def.nameJa || r.def.name, { class: 'rank-row__icon' }),
      h('span', { class: 'rank-row__name' }, r.def.nameJa || r.def.name),
      h('span', { class: 'rank-row__fp num' }, `${r.fp}`),
        h('span', { class: 'rank-row__unit muted' }, uiText(db, 'drive.fortPoints')))))),
    h('div', { class: 'result__actions' },
      h('button', { class: 'btn-primary', type: 'button', onClick: () => restart() }, uiText(db, 'result.again'))));
}

/** 数字を転がす（1 行ずつ少しずらして、全体で 1.5 秒以内） */
export function mount(app, el) {
  const cells = [...el.querySelectorAll('.roll')];
  if (reducedMotion()) {
    for (const c of cells) c.textContent = Number(c.dataset.to).toLocaleString('ja-JP');
    return;
  }
  const delay = 50;
  cells.forEach((c, i) => {
    const to = Number(c.dataset.to) || 0;
    const t0 = performance.now() + i * delay;
    const tick = (now) => {
      const p = Math.min(1, Math.max(0, (now - t0) / ROLL_MS));
      const eased = 1 - Math.pow(1 - p, 3);
      c.textContent = Math.round(to * eased).toLocaleString('ja-JP');
      if (p < 1) rafs.push(requestAnimationFrame(tick));
    };
    rafs.push(requestAnimationFrame(tick));
  });
}

export function unmount() {
  for (const id of rafs) cancelAnimationFrame(id);
  rafs = [];
}
