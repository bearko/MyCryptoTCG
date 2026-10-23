// drive-view.js — MCH Drive（SPEC-111 §6）
//
// タブ: ヒーロー / 砦とエネミー / ランド（app.ui.driveTab）。
// SOUL の選択（pending.kind === "soul"）はここ: 3 体のカードを横に並べ、1 体タップ → 確認 → souls.accept。
// 数値（装備込みのパラメーター・兵の上限・射程）は heroes.js に聞く。占領数は season.tileCount と同じ数え方を
// 探索済みのタイルに絞って数える（見えていない所は数えない）。

import { h, heroImg, imgEl, landAssetPath, toast } from './h.js';
import { uiText, say } from '../engine/lines.js';
import { effectiveParams, troopCap, rangeOf, PARAM_KEYS } from '../engine/heroes.js';
import { accept } from '../engine/souls.js';
import { save } from '../state.js';
import { render as renderApp, confirmPopup, go } from '../main.js';

const TABS = ['heroes', 'forts', 'lands'];
const TAB_KEY = { heroes: 'drive.tabHeroes', forts: 'drive.tabForts', lands: 'drive.tabLands' };

const t = (app, key) => uiText(app.db, key);
const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? m : String(vars[k])));

function heroOf(db, id) {
  return db.heroes[id] || db.heroes[String(id)] || null;
}

function landDef(app, id) {
  return (app.db.lands || []).find((l) => l.id === id) || null;
}

function landName(app, id) {
  if (id === 'enemy') return t(app, 'map.enemyLand');
  const d = landDef(app, id);
  return d ? d.nameJa || d.name : String(id);
}

// 棒グラフの目盛り（データ中の最大値。表示のためだけ）
let scaleCache = null;
function paramScale(db) {
  if (scaleCache && scaleCache.db === db) return scaleCache.max;
  const max = {};
  for (const k of PARAM_KEYS) max[k] = 1;
  for (const hero of db.heroList || Object.values(db.heroes || {})) {
    for (const k of PARAM_KEYS) if (hero.params && hero.params[k] > max[k]) max[k] = hero.params[k];
  }
  scaleCache = { db, max };
  return max;
}

/** 6 パラメーターの棒（装備の加算は色を変えて足す） */
export function paramBars(app, hero, squad) {
  const base = hero.params || {};
  const eff = squad ? effectiveParams(hero, squad, app.db) : base;
  const max = paramScale(app.db);
  return h('dl', { class: 'param-bars' }, PARAM_KEYS.map((k) => {
    const b = base[k] || 0;
    const e = eff[k] || 0;
    const top = Math.max(max[k], e);
    const plus = e - b;
    return h('div', { class: 'param-bar' },
      h('dt', null, t(app, `param.${k}`)),
      h('dd', null,
        h('span', { class: 'param-bar__track', 'aria-hidden': 'true' },
          h('span', { class: 'param-bar__fill', style: { width: `${Math.min(100, (Math.min(b, e) / top) * 100)}%` } }),
          plus > 0 ? h('span', { class: 'param-bar__plus', style: { width: `${Math.min(100, (plus / top) * 100)}%` } }) : null),
        h('span', { class: 'param-bar__val num' }, String(e), plus > 0 ? h('small', { class: 'param-bar__delta' }, ` +${plus}`) : null)));
  }));
}

function clsText(app, hero) {
  const c = hero.cls || {};
  return `${t(app, `cls.${c.main}`)} / ${t(app, `sub.${c.sub}`)}`;
}

function rarityTag(app, hero) {
  return h('span', { class: 'rarity-tag', dataset: { rarity: hero.rarity } }, t(app, `rarity.${hero.rarity}`));
}

function skillLine(app, hero) {
  const s = hero.skill;
  if (!s) return null;
  return h('p', { class: 'hero-skill' },
    h('span', { class: 'hero-skill__label muted' }, t(app, 'drive.skill')), ' ',
    h('strong', null, s.name), ' ',
    h('span', { class: 'skill-kind', dataset: { kind: s.kind } }, t(app, `skill.${s.kind}`)));
}

// ------------------------------------------------------------
// ヒーロー
// ------------------------------------------------------------

function heroCard(app, squad) {
  const db = app.db;
  const hero = heroOf(db, squad.heroId);
  if (!hero) return null;
  const cap = troopCap(hero, squad, db);
  const ext = squad.equip ? db.extensions[squad.equip] : null;
  return h('article', { class: 'hero-card', dataset: { rarity: hero.rarity, squad: squad.id } },
    h('header', { class: 'hero-card__head' },
      h('span', { class: 'hero-card__art' }, heroImg(hero, { class: 'hero-card__img', width: 64, height: 64 })),
      h('div', { class: 'hero-card__title' },
        h('h3', { class: 'hero-card__name' }, hero.name),
        h('p', { class: 'hero-card__meta' }, rarityTag(app, hero), ' ',
          h('span', { class: 'muted' }, `${t(app, 'drive.squadType')} `), clsText(app, hero)),
        h('p', { class: 'hero-card__meta num' },
          h('span', { class: 'muted' }, `${t(app, 'param.troops')} `), `${squad.troops} / ${cap}`,
          h('span', { class: 'muted' }, `　${t(app, 'drive.range')} `), String(rangeOf(hero)),
          squad.status === 'routed' ? h('span', { class: 'tag tag--danger' }, ` ${t(app, 'map.routed')}`) : null))),
    paramBars(app, hero, squad),
    skillLine(app, hero),
    h('p', { class: 'hero-card__equip' },
      h('span', { class: 'muted' }, `${t(app, 'drive.equip')} `),
      ext
        ? h('button', { class: 'btn-ghost hero-card__ext', type: 'button', onClick: () => go('photo') },
          imgEl(ext.image, ext.name, { class: 'hero-card__ext-img', width: 24, height: 24 }), ext.name, h('small', { class: 'muted' }, ` ${ext.text}`))
        : h('span', { class: 'muted' }, t(app, 'drive.noEquip'))));
}

function heroesTab(app) {
  const st = app.state;
  const mine = Object.values(st.squads || {}).filter((s) => s.land === st.playerLand);
  if (!mine.length) return h('p', { class: 'empty muted' }, t(app, 'chat.noSquads'));
  return h('div', { class: 'hero-list' }, mine.map((s) => heroCard(app, s)));
}

// ------------------------------------------------------------
// 砦とエネミー
// ------------------------------------------------------------

function fortsTab(app) {
  const st = app.state;
  const db = app.db;
  const me = st.lands[st.playerLand];
  const seen = new Set(me.explored || []);
  const order = { legendary: 0, epic: 1, rare: 2 };
  const forts = Object.values(st.forts || {}).sort((a, b) => (order[a.rank] - order[b.rank]) || String(a.id).localeCompare(String(b.id), 'en', { numeric: true }));
  return h('ul', { class: 'fort-list' }, forts.map((f) => {
    if (!seen.has(f.tile)) {
      return h('li', { class: 'fort-card is-unknown', dataset: { rank: f.rank } },
        h('span', { class: 'fort-card__art fort-card__art--unknown', 'aria-hidden': 'true' }, t(app, 'fort.unknown')),
        h('div', { class: 'fort-card__body' },
          h('h3', { class: 'fort-card__name' }, t(app, `fort.${f.rank}`)),
          h('p', { class: 'muted' }, t(app, 'map.unexplored'))));
    }
    const enemy = (db.enemies || []).find((e) => e.id === f.enemyId);
    const own = f.owner === st.playerLand;
    const ld = landDef(app, f.owner);
    const pct = f.maxDurability ? Math.round((f.durability / f.maxDurability) * 100) : 0;
    return h('li', { class: ['fort-card', own ? 'is-mine' : null], dataset: { rank: f.rank }, style: ld ? { '--land': ld.color } : null },
      h('button', { class: 'fort-card__btn', type: 'button', 'aria-label': `${f.name} ${t(app, 'app.map')}`, onClick: () => go('map', { tile: f.tile }) },
        h('span', { class: 'fort-card__art' },
          enemy ? imgEl(enemy.image, enemy.name, { class: 'fort-card__img pixel', width: 56, height: 56 }) : h('span', { class: 'img-fallback' }, '?')),
        h('div', { class: 'fort-card__body' },
          h('h3', { class: 'fort-card__name' }, h('span', { class: 'fort-rank' }, t(app, `fort.${f.rank}`)), ' ', f.name),
          h('p', { class: 'fort-card__meta' }, h('span', { class: 'muted' }, `${t(app, 'map.owner')} `),
            h('span', { class: 'fort-card__owner' }, landName(app, f.owner)),
            enemy ? h('span', { class: 'muted' }, `　${t(app, 'drive.enemy')} ${enemy.name}`) : null),
          h('p', { class: 'fort-card__meta num' },
            h('span', { class: 'muted' }, `${t(app, 'fort.troops')} `), String(f.troops),
            h('span', { class: 'muted' }, `　${t(app, 'fort.durability')} `), `${f.durability} / ${f.maxDurability}`),
          h('span', { class: 'dur-bar', 'aria-hidden': 'true' }, h('span', { class: 'dur-bar__fill', style: { width: `${pct}%` } })))));
  }));
}

// ------------------------------------------------------------
// ランド
// ------------------------------------------------------------

function landsTab(app) {
  const st = app.state;
  const me = st.lands[st.playerLand];
  const seen = new Set(me.explored || []);
  const tiles = st.map.tiles;
  const counts = {};
  for (const i of seen) {
    const o = tiles[i] && tiles[i].owner;
    if (o) counts[o] = (counts[o] || 0) + 1;
  }
  const heroes = {};
  for (const s of Object.values(st.squads || {})) {
    if (s.land === st.playerLand || seen.has(s.tile)) heroes[s.land] = (heroes[s.land] || 0) + 1;
  }
  const rows = (app.db.lands || []).filter((l) => st.lands[l.id]).map((l) => ({ def: l, land: st.lands[l.id] }))
    .sort((a, b) => (b.land.fortPoints || 0) - (a.land.fortPoints || 0));
  return h('div', { class: 'land-table-wrap' },
    h('table', { class: 'land-table' },
      h('caption', { class: 'muted' }, t(app, 'drive.landsNote')),
      h('thead', null, h('tr', null,
        h('th', { scope: 'col' }, t(app, 'drive.tabLands')),
        h('th', { scope: 'col' }, t(app, 'drive.fortPoints')),
        h('th', { scope: 'col' }, t(app, 'drive.tiles')),
        h('th', { scope: 'col' }, t(app, 'drive.heroes')))),
      h('tbody', null, rows.map(({ def, land }) => h('tr', {
        class: [def.id === st.playerLand ? 'is-me' : null, land.alive === false ? 'is-out' : null], style: { '--land': def.color },
      },
      h('th', { scope: 'row' },
        h('span', { class: 'land-cell' }, imgEl(landAssetPath(def.icon), def.nameJa || def.name, { class: 'land-cell__icon', width: 24, height: 24 }),
          h('span', null, def.nameJa || def.name))),
      h('td', { class: 'num' }, String(land.fortPoints || 0)),
      h('td', { class: 'num' }, String(counts[def.id] || 0)),
      h('td', { class: 'num' }, String(heroes[def.id] || 0)))))));
}

// ------------------------------------------------------------
// SOUL の選択
// ------------------------------------------------------------

function pickSoul(app, pending, heroId) {
  const hero = heroOf(app.db, heroId);
  if (!hero) return;
  confirmPopup(fill(t(app, 'drive.soulConfirm'), { name: hero.name }), () => {
    const st = app.state;
    let squad;
    try {
      squad = accept(st, app.db, st.playerLand, pending, heroId);
    } catch (e) {
      console.error(e);
      return;
    }
    save(st);
    app.ui.driveTab = 'heroes';
    renderApp();
    toast(say(app.db, hero, 'join', { name: hero.name }), { key: 'soul-join' });
    const card = document.querySelector(`.hero-card[data-squad="${squad.id}"]`);
    if (card) {
      card.classList.add('is-new');
      card.scrollIntoView({ block: 'nearest' });
    }
  }, { title: t(app, 'drive.soulTitle'), okText: t(app, 'drive.soulPick') });
}

function soulSection(app) {
  const st = app.state;
  const list = (st.pending || []).filter((p) => p.kind === 'soul' && p.land === st.playerLand);
  if (!list.length) return null;
  const p = list[0];
  const soul = p.soul || {};
  return h('section', { class: 'soul', 'aria-labelledby': 'soul-title' },
    h('h2', { class: 'soul__title', id: 'soul-title' }, t(app, 'drive.soulTitle')),
    h('p', { class: 'soul__lead muted' },
      `${t(app, `cls.${soul.role}`)} ・ ${t(app, `rarity.${soul.rarity}`)}`,
      list.length > 1 ? `　${fill(t(app, 'drive.soulLeft'), { n: list.length })}` : ''),
    h('div', { class: 'soul__cards' }, (p.candidates || []).map((id) => {
      const hero = heroOf(app.db, id);
      if (!hero) return null;
      return h('button', {
        class: 'soul-card', type: 'button', dataset: { rarity: hero.rarity, hero: hero.id },
        'aria-label': `${hero.name} ${t(app, `rarity.${hero.rarity}`)} ${clsText(app, hero)}`,
        onClick: () => pickSoul(app, p, hero.id),
      },
      h('span', { class: 'soul-card__art' }, heroImg(hero, { class: 'soul-card__img', width: 64, height: 64 })),
      h('span', { class: 'soul-card__name' }, hero.name),
      rarityTag(app, hero),
      h('span', { class: 'soul-card__cls muted' }, clsText(app, hero)),
      paramBars(app, hero, null),
      hero.skill ? h('span', { class: 'soul-card__skill' }, hero.skill.name) : null);
    })));
}

// ------------------------------------------------------------

export function render(app) {
  const tab = TABS.includes(app.ui.driveTab) ? app.ui.driveTab : 'heroes';
  app.ui.driveTab = tab;
  const body = tab === 'heroes' ? heroesTab(app) : tab === 'forts' ? fortsTab(app) : landsTab(app);
  return h('section', { class: 'app-screen app-screen--drive drive' },
    h('header', { class: 'app-head' },
      h('h1', { class: 'app-title' }, t(app, 'app.drive')),
      h('span', { class: 'app-head__sub muted' }, t(app, 'drive.title'))),
    soulSection(app),
    h('div', { class: 'tabs', role: 'tablist', 'aria-label': t(app, 'drive.title') }, TABS.map((k) => h('button', {
      class: ['tab', k === tab ? 'is-active' : null], type: 'button', role: 'tab', id: `drive-tab-${k}`,
      'aria-selected': k === tab ? 'true' : 'false', 'aria-controls': 'drive-panel', tabindex: k === tab ? '0' : '-1',
      onClick: () => { app.ui.driveTab = k; renderApp(); },
      onKeydown: (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        const i = TABS.indexOf(k) + (e.key === 'ArrowRight' ? 1 : -1);
        app.ui.driveTab = TABS[(i + TABS.length) % TABS.length];
        renderApp();
        const b = document.getElementById(`drive-tab-${app.ui.driveTab}`);
        if (b) b.focus();
      },
    }, t(app, TAB_KEY[k])))),
    h('div', { class: 'tab-panel', role: 'tabpanel', id: 'drive-panel', 'aria-labelledby': `drive-tab-${tab}` }, body));
}
