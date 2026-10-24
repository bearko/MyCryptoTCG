// result-view.js — 結果（SPEC-111 §9・SPEC-112 §6）
//
// 理由・9 ランドの砦ポイント順位・season.score の内訳・もう一度。
// 順位は下から 1 つずつせり上がり、自ランドの行が光る。内訳は 1 行ずつ数字が転がる。
// ナビゲーターは勝てば喜ぶ差分、負ければ励ます差分。
// 点の計算は season.score に聞く（ここでは足し算もしない）。

import { h, imgEl, landAssetPath } from './h.js';
import { uiText } from '../engine/lines.js';
import { score, tileCount } from '../engine/season.js';
import { restart } from '../main.js';
import { navi } from './phone.js';
import * as fx from './fx.js';

const BREAKDOWN_KEYS = ['fortPoints', 'tiles', 'heroes', 'facilities', 'clear', 'daysLeft'];
/** 1 行の数字が転がる時間（ms）と、行どうしのずれ */
const ROLL_MS = 520;
const ROW_GAP = 170;

let timers = [];

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

function fmt(n) {
  return Math.round(n).toLocaleString('ja-JP');
}

function naviLine(app, ended, won) {
  const me = landDef(app, app.state.playerLand);
  const fill = (s) => s.replace('{land}', me.nameJa || me.name);
  if (won && ended.reason === 'clear') return { face: 'sparkle', text: uiText(app.db, 'navi.result.clear') };
  if (won) return { face: 'happy', text: fill(uiText(app.db, 'navi.result.win')) };
  if (ended.reason === 'giveup') return { face: 'smile', text: uiText(app.db, 'navi.result.giveup') };
  return { face: 'teary', text: uiText(app.db, 'navi.result.lose') };
}

export function render(app) {
  const st = app.state;
  const db = app.db;
  const ended = st.ended || { reason: 'season', winner: null };
  const sc = score(st, db, st.playerLand);
  const winner = ended.winner ? landDef(app, ended.winner) : null;
  const won = ended.winner === st.playerLand;
  const me = landDef(app, st.playerLand);
  const line = naviLine(app, ended, won);
  const nv = navi(app, { face: line.face, text: line.text, ctx: `result:${st.seed}`, cls: 'result__navi' });
  nv.bubble.classList.add('result__bubble');

  const rows = BREAKDOWN_KEYS.map((k) => h('div', { class: ['score-row', (sc.breakdown[k] || 0) === 0 ? 'is-zero' : null] },
    h('dt', null, uiText(db, `result.bd.${k}`)),
    h('dd', { class: 'num roll', dataset: { to: sc.breakdown[k] || 0 } }, fmt(sc.breakdown[k] || 0))));

  const ranking = rankLands(app);
  const root = h('section', { class: ['result', won ? 'is-win' : null], style: { '--land': me.color } },
    h('header', { class: 'result__head' },
      h('div', { class: 'result__navi-clip' }, nv.figure),
      h('span', { class: 'result__eyebrow' }, uiText(db, 'result.title')),
      h('h1', { class: 'result__title' }, uiText(db, won ? 'result.headWin' : 'result.headEnd')),
      h('p', { class: 'result__reason' },
        h('span', { class: 'muted' }, uiText(db, 'result.reason')), ' ',
        h('strong', null, uiText(db, `end.${ended.reason}`))),
      winner ? h('p', { class: 'result__winner', style: { '--land': winner.color } },
        h('span', { class: 'muted' }, uiText(db, 'result.winner')), ' ',
        h('strong', null, winner.nameJa || winner.name)) : null,
      nv.bubble),
    h('section', { class: 'result__score panel', 'aria-labelledby': 'result-score-title' },
      h('h2', { class: 'section-title', id: 'result-score-title' }, uiText(db, 'result.score')),
      h('dl', { class: 'score-list' }, rows,
        h('div', { class: 'score-row score-row--total' },
          h('dt', null, uiText(db, 'result.total')),
          h('dd', { class: 'num roll', dataset: { to: sc.total } }, fmt(sc.total))))),
    h('section', { class: 'result__rank panel', 'aria-labelledby': 'result-rank-title' },
      h('h2', { class: 'section-title', id: 'result-rank-title' }, uiText(db, 'result.rank')),
      h('ol', { class: 'rank-list' }, ranking.map((r, i) => h('li', {
        class: ['rank-row', r.def.id === st.playerLand ? 'is-me' : null, r.land.alive === false ? 'is-out' : null],
        style: { '--land': r.def.color },
      },
      h('span', { class: 'rank-row__no num' }, String(i + 1)),
      imgEl(landAssetPath(r.def.icon), r.def.nameJa || r.def.name, { class: 'rank-row__icon' }),
      h('span', { class: 'rank-row__name' }, r.def.nameJa || r.def.name,
        r.def.id === st.playerLand ? h('span', { class: 'rank-row__me' }, uiText(db, 'result.me')) : null),
      h('span', { class: 'rank-row__fp num' }, `${r.fp}`),
      h('span', { class: 'rank-row__unit muted' }, uiText(db, 'drive.fortPoints')))))),
    h('div', { class: 'result__actions' },
      h('button', { class: 'btn-primary', type: 'button', onClick: () => restart() }, uiText(db, 'result.again'))));
  root._navi = nv;
  return root;
}

/**
 * 内訳は 1 行ずつ数字が転がる（最後に合計）。順位は下の行から 1 つずつせり上がる。
 * 文字は最初から最終の値で入れてある（読み上げ・動きを減らすときはそのまま）。
 */
export function mount(app, el) {
  if (!el) return;
  if (el._navi) el._navi.start();
  if (fx.reducedMotion()) return;
  const rows = [...el.querySelectorAll('.score-row')];
  fx.stagger(rows, { step: ROW_GAP, delay: 200, from: 'left', distance: 16, ms: 360 });
  rows.forEach((row, i) => {
    const cell = row.querySelector('.roll');
    if (!cell) return;
    const to = Number(cell.dataset.to) || 0;
    cell.textContent = '0';
    const total = row.classList.contains('score-row--total');
    timers.push(setTimeout(() => {
      if (!cell.isConnected) return;
      fx.rollNumber(cell, to, { from: 0, ms: total ? 900 : ROLL_MS, format: fmt, flash: to > 0 });
      if (total) row.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.05)', offset: 0.85 }, { transform: 'none' }], { duration: 1000, easing: 'ease-out' });
    }, 200 + i * ROW_GAP));
  });
  // 順位: 下（最下位）から 1 つずつせり上がる
  const ranks = [...el.querySelectorAll('.rank-row')].reverse();
  fx.stagger(ranks, { step: 90, delay: 560, from: 'up', distance: 26, ms: 460 });
}

export function unmount() {
  for (const id of timers) clearTimeout(id);
  timers = [];
}
