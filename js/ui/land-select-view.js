// land-select-view.js — ランド選択（最初の画面。SPEC-111 §1）
//
// 9 ランドのカード（ランドの色・ランドセクタのアイコン・クリプタイド）。1 枚タップで newGame → save → home。

import { h, imgEl, landAssetPath } from './h.js';
import { uiText } from '../engine/lines.js';
import { startGame } from '../main.js';

let starting = false;

function newSeed() {
  // UI 側なので Date.now を使ってよい（engine には渡すだけ）
  return (Date.now() ^ Math.floor(performance.now() * 1000)) >>> 0;
}

function pickLand(app, land, card) {
  if (starting) return;
  starting = true;
  card.classList.add('is-picked');
  const root = card.closest('.land-select');
  if (root) root.setAttribute('aria-busy', 'true');
  // 描画を 1 回挟んでから世界を作る（押したことが見えるように）
  setTimeout(() => {
    try {
      startGame(land.id, newSeed());
    } catch (e) {
      console.error(e);
      card.classList.remove('is-picked');
      if (root) root.removeAttribute('aria-busy');
    } finally {
      starting = false;
    }
  }, 30);
}

export function render(app) {
  const lands = app.db.lands || [];
  const root = h('section', { class: 'land-select' },
    h('header', { class: 'land-select__head' },
      h('h1', { class: 'land-select__title' }, uiText(app.db, 'land.title')),
      h('p', { class: 'land-select__lead muted' }, uiText(app.db, 'land.lead'))));
  const grid = h('div', { class: 'land-grid' });
  for (const land of lands) {
    const name = land.nameJa || land.name;
    const card = h('button', {
      class: 'land-card', type: 'button', style: { '--land': land.color }, dataset: { land: land.id },
      'aria-label': `${name}（${land.name}）${uiText(app.db, 'land.start')}`,
    },
    h('span', { class: 'land-card__art' },
      imgEl(landAssetPath(land.cryptid), `${name}のクリプタイド`, { class: 'land-card__cryptid' }),
      imgEl(landAssetPath(land.icon), `${name}のランドセクタ`, { class: 'land-card__icon' })),
    h('span', { class: 'land-card__name' }, name),
    h('span', { class: 'land-card__en muted' }, land.name));
    card.addEventListener('click', () => pickLand(app, land, card));
    grid.appendChild(card);
  }
  root.appendChild(grid);
  return root;
}
