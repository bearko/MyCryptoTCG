// drive-view.js — MCH Drive（SPEC-111 §6・SPEC-112 §5）
//
// タブ: ヒーロー / 砦とエネミー / ランド（app.ui.driveTab）。タブは金の板が横にすべり、中身は横から入る。
// ヒーローのカードは絵を大きく、名前の「裏」に絵が少しはみ出す（SPEC-112 B）。レアリティは縁の色と光沢。
// パラメーターの棒は入ってきたときに左から伸び、数字が転がる。用語は「?」で説明する（統率力・知力など）。
// SOUL の選択（pending.kind === "soul"）はここ: 3 枚が裏向きで出て、順にめくれる（600ms ずつ）。
// 1 枚タップ → そのカードが前に出てほかは下がる → 確認 → souls.accept → カットインで迎える。
// 数値（装備込みのパラメーター・兵の上限・射程）は heroes.js に聞く。占領数は season.tileCount と同じ数え方を
// 探索済みのタイルに絞って数える（見えていない所は数えない）。

import { h, heroImg, imgEl, landAssetPath, toast } from './h.js';
import { uiText, say } from '../engine/lines.js';
import { effectiveParams, troopCap, rangeOf, PARAM_KEYS } from '../engine/heroes.js';
import { accept } from '../engine/souls.js';
import { save } from '../state.js';
import { render as renderApp, openPopup, closePopup, go } from '../main.js';
import { appHead, helpPopup, firstGuide, markGuideSeen, entering, leave, tx } from './app-kit.js';
import * as fx from './fx.js';

const TABS = ['heroes', 'forts', 'lands'];
const TAB_KEY = { heroes: 'drive.tabHeroes', forts: 'drive.tabForts', lands: 'drive.tabLands' };
/** SOUL のカードが 1 枚めくれるまで（SPEC-112 §5） */
export const SOUL_FLIP_MS = 600;

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

// ------------------------------------------------------------
// 用語の「?」
// ------------------------------------------------------------

/** 用語の説明（6 つのパラメーターと、カードに出る言葉） */
function termItems(app) {
  const params = PARAM_KEYS.map((k) => ({ id: k, term: t(app, `param.${k}`), text: t(app, `help.param.${k}`), tag: h('span', { class: 'terms__dot', dataset: { param: k }, 'aria-hidden': 'true' }) }));
  const more = ['troops', 'range', 'skill', 'squadType', 'equip', 'fortPoints'].map((k) => ({
    id: k, term: k === 'troops' ? t(app, 'param.troops') : t(app, `drive.${k}`), text: t(app, `help.drive.${k}`),
  }));
  return params.concat(more);
}

export function openHelp(app, focus) {
  helpPopup(app, { title: tx(app, 'help.driveTitle', '用語の説明'), lead: tx(app, 'help.driveLead', ''), items: termItems(app), focus });
}

/** 用語のボタン（押すとその用語を光らせて説明を出す）。ボタンの中では使えないので、そのときは文字だけ */
function term(app, id, label, inButton) {
  if (inButton) return h('span', { class: 'term term--plain' }, label);
  return h('button', {
    class: 'term', type: 'button', dataset: { term: id }, 'aria-label': `${label} ${tx(app, 'help.title', '説明')}`,
    onClick: (e) => { e.stopPropagation(); openHelp(app, id); },
  }, label, h('span', { class: 'term__q', 'aria-hidden': 'true' }, '?'));
}

// ------------------------------------------------------------
// 部品
// ------------------------------------------------------------

/** 6 パラメーターの棒（装備の加算は色を変えて足す）。入ってきたときに左から伸びる */
export function paramBars(app, hero, squad, opts = {}) {
  const base = hero.params || {};
  const eff = squad ? effectiveParams(hero, squad, app.db) : base;
  const max = paramScale(app.db);
  return h('dl', { class: 'param-bars' }, PARAM_KEYS.map((k, j) => {
    const b = base[k] || 0;
    const e = eff[k] || 0;
    const top = Math.max(max[k], e);
    const plus = e - b;
    return h('div', { class: 'param-bar', dataset: { param: k }, style: { '--j': String(j) } },
      h('dt', null, term(app, k, t(app, `param.${k}`), opts.inButton)),
      h('dd', null,
        h('span', { class: 'param-bar__track', 'aria-hidden': 'true' },
          h('span', { class: 'param-bar__grow' },
            h('span', { class: 'param-bar__fill', style: { width: `${Math.min(100, (Math.min(b, e) / top) * 100)}%` } }),
            plus > 0 ? h('span', { class: 'param-bar__plus', style: { width: `${Math.min(100, (plus / top) * 100)}%` } }) : null)),
        h('span', { class: 'param-bar__val num' },
          h('span', { class: 'param-bar__num', dataset: { to: e } }, String(e)),
          plus > 0 ? h('small', { class: 'param-bar__delta' }, `+${plus}`) : null)));
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
  return h('button', {
    class: 'hero-skill', type: 'button', 'aria-label': `${t(app, 'drive.skill')} ${s.name}`,
    onClick: () => helpPopup(app, {
      title: s.name,
      items: [{ id: 'skill', term: t(app, `skill.${s.kind}`), text: s.text || t(app, 'help.drive.skill'), tag: h('span', { class: 'skill-kind', dataset: { kind: s.kind } }, t(app, 'drive.skill')) }],
      focus: 'skill',
    }),
  },
  h('span', { class: 'hero-skill__label' }, t(app, 'drive.skill')),
  h('strong', { class: 'hero-skill__name' }, s.name),
  h('span', { class: 'skill-kind', dataset: { kind: s.kind } }, t(app, `skill.${s.kind}`)),
  h('span', { class: 'hero-skill__more', 'aria-hidden': 'true' }));
}

// ------------------------------------------------------------
// ヒーロー
// ------------------------------------------------------------

function heroCard(app, squad, i) {
  const db = app.db;
  const hero = heroOf(db, squad.heroId);
  if (!hero) return null;
  const cap = troopCap(hero, squad, db);
  const ext = squad.equip ? db.extensions[squad.equip] : null;
  const pct = cap ? Math.max(0, Math.min(100, (squad.troops / cap) * 100)) : 0;
  return h('article', {
    class: ['hero-card', squad.status === 'routed' ? 'is-routed' : null],
    dataset: { rarity: hero.rarity, squad: squad.id }, style: { '--i': String(i) },
  },
  // 光沢と縁（カードの形に切り抜く層。絵は切り抜かずに上へはみ出す）
  h('span', { class: 'hero-card__skin', 'aria-hidden': 'true' }, h('span', { class: 'hero-card__gloss' })),
  // 絵は名前の「裏」（文字が手前に重なる）
  h('span', { class: 'hero-card__art', 'aria-hidden': 'true' },
    h('span', { class: 'hero-card__halo' }),
    heroImg(hero, { class: 'hero-card__img', width: 128, height: 128, alt: '' })),
  h('header', { class: 'hero-card__head' },
    h('p', { class: 'hero-card__meta' }, rarityTag(app, hero), h('span', { class: 'hero-card__cls' }, clsText(app, hero))),
    h('h3', { class: 'hero-card__name' }, hero.name),
    h('div', { class: 'hero-card__stats num' },
      h('span', { class: 'stat' },
        h('span', { class: 'stat__label' }, term(app, 'troops', t(app, 'param.troops'))),
        h('span', { class: 'stat__val' }, h('b', null, String(squad.troops)), h('small', null, ` / ${cap}`)),
        h('span', { class: 'stat__bar', 'aria-hidden': 'true' }, h('span', { class: 'stat__fill', style: { width: `${pct}%` } }))),
      h('span', { class: 'stat' },
        h('span', { class: 'stat__label' }, term(app, 'range', t(app, 'drive.range'))),
        h('span', { class: 'stat__val' }, h('b', null, String(rangeOf(hero))))),
      squad.status === 'routed' ? h('span', { class: 'tag tag--danger' }, t(app, 'map.routed')) : null)),
  paramBars(app, hero, squad),
  h('footer', { class: 'hero-card__foot' },
    skillLine(app, hero),
    h('div', { class: 'hero-card__equip' },
      h('span', { class: 'hero-card__equip-label' }, t(app, 'drive.equip')),
      ext
        ? h('button', { class: 'hero-card__ext', type: 'button', onClick: () => go('photo') },
          imgEl(ext.image, ext.name, { class: 'hero-card__ext-img', width: 28, height: 28 }),
          h('span', { class: 'hero-card__ext-name' }, ext.name), h('small', null, ext.text))
        : h('button', { class: 'hero-card__ext is-empty', type: 'button', onClick: () => go('photo') },
          h('span', { class: 'hero-card__ext-slot', 'aria-hidden': 'true' }), h('span', null, t(app, 'drive.noEquip'))))));
}

function heroesTab(app) {
  const st = app.state;
  const mine = Object.values(st.squads || {}).filter((s) => s.land === st.playerLand);
  if (!mine.length) return h('p', { class: 'empty muted' }, t(app, 'chat.noSquads'));
  return h('div', { class: 'hero-list' }, mine.map((s, i) => heroCard(app, s, i)));
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
  return h('ul', { class: 'fort-list' }, forts.map((f, i) => {
    if (!seen.has(f.tile)) {
      return h('li', { class: 'fort-card is-unknown', dataset: { rank: f.rank }, style: { '--i': String(i) } },
        h('span', { class: 'fort-card__art fort-card__art--unknown', 'aria-hidden': 'true' }, t(app, 'fort.unknown')),
        h('div', { class: 'fort-card__body' },
          h('h3', { class: 'fort-card__name' }, h('span', { class: 'fort-rank' }, t(app, `fort.${f.rank}`))),
          h('p', { class: 'muted' }, t(app, 'map.unexplored'))));
    }
    const enemy = (db.enemies || []).find((e) => e.id === f.enemyId);
    const own = f.owner === st.playerLand;
    const ld = landDef(app, f.owner);
    const pct = f.maxDurability ? Math.round((f.durability / f.maxDurability) * 100) : 0;
    return h('li', { class: ['fort-card', own ? 'is-mine' : null], dataset: { rank: f.rank }, style: { '--i': String(i), '--land': ld ? ld.color : null } },
      h('button', { class: 'fort-card__btn', type: 'button', 'aria-label': `${f.name} ${t(app, 'app.map')}`, onClick: () => go('map', { tile: f.tile }) },
        h('span', { class: 'fort-card__art' },
          enemy ? imgEl(enemy.image, enemy.name, { class: 'fort-card__img pixel', width: 64, height: 64 }) : h('span', { class: 'img-fallback' }, '?')),
        h('div', { class: 'fort-card__body' },
          h('h3', { class: 'fort-card__name' }, h('span', { class: 'fort-rank' }, t(app, `fort.${f.rank}`)), ' ', f.name),
          h('p', { class: 'fort-card__meta' }, h('span', { class: 'muted' }, `${t(app, 'map.owner')} `),
            h('span', { class: 'fort-card__owner' }, landName(app, f.owner)),
            enemy ? h('span', { class: 'muted' }, `　${t(app, 'drive.enemy')} ${enemy.name}`) : null),
          h('p', { class: 'fort-card__meta num' },
            h('span', { class: 'muted' }, `${t(app, 'fort.troops')} `), String(f.troops),
            h('span', { class: 'muted' }, `　${t(app, 'fort.durability')} `), `${f.durability} / ${f.maxDurability}`),
          h('span', { class: 'dur-bar', 'aria-hidden': 'true' }, h('span', { class: 'dur-bar__fill', style: { width: `${pct}%` } }))),
        h('span', { class: 'fort-card__go', 'aria-hidden': 'true' })));
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
  const topFp = Math.max(1, ...rows.map((r) => r.land.fortPoints || 0));
  return h('div', { class: 'land-table-wrap' },
    h('table', { class: 'land-table' },
      h('caption', { class: 'muted' }, t(app, 'drive.landsNote')),
      h('thead', null, h('tr', null,
        h('th', { scope: 'col' }, t(app, 'drive.tabLands')),
        h('th', { scope: 'col' }, term(app, 'fortPoints', t(app, 'drive.fortPoints'))),
        h('th', { scope: 'col' }, t(app, 'drive.tiles')),
        h('th', { scope: 'col' }, t(app, 'drive.heroes')))),
      h('tbody', null, rows.map(({ def, land }, i) => h('tr', {
        class: [def.id === st.playerLand ? 'is-me' : null, land.alive === false ? 'is-out' : null],
        style: { '--land': def.color, '--i': String(i), '--fp': String((land.fortPoints || 0) / topFp) },
      },
      h('th', { scope: 'row' },
        h('span', { class: 'land-cell' },
          h('span', { class: 'land-cell__rank num' }, String(i + 1)),
          imgEl(landAssetPath(def.icon), def.nameJa || def.name, { class: 'land-cell__icon', width: 24, height: 24 }),
          h('span', null, def.nameJa || def.name))),
      h('td', { class: 'num land-table__fp' }, h('span', { class: 'land-table__fpbar', 'aria-hidden': 'true' }), h('span', { class: 'land-table__fpval' }, String(land.fortPoints || 0))),
      h('td', { class: 'num' }, String(counts[def.id] || 0)),
      h('td', { class: 'num' }, String(heroes[def.id] || 0)))))));
}

// ------------------------------------------------------------
// SOUL の選択
// ------------------------------------------------------------

/** 裏向きから全部めくれ終わった SOUL（同じ SOUL の描き直しでは、めくりをやり直さない） */
let soulRevealed = null;
/** 選んで確認を出している間のカード */
let soulPicking = null;

function soulKey(p) {
  return `${p.soul && p.soul.from}:${(p.candidates || []).join(',')}`;
}

function pickSoul(app, pending, heroId, cardEl) {
  const hero = heroOf(app.db, heroId);
  if (!hero) return;
  const wrap = cardEl && cardEl.closest('.soul__cards');
  // 選んだ 1 枚が前に出て、ほかは下がる
  if (wrap) {
    wrap.classList.add('is-picking');
    for (const c of wrap.querySelectorAll('.soul-card')) c.classList.toggle('is-chosen', c === cardEl);
  }
  soulPicking = heroId;
  const body = h('div', { class: 'soul-confirm', dataset: { rarity: hero.rarity } },
    h('div', { class: 'soul-confirm__art' },
      h('span', { class: 'soul-confirm__rays', 'aria-hidden': 'true' }),
      heroImg(hero, { class: 'soul-confirm__img', width: 128, height: 128 })),
    h('p', { class: 'soul-confirm__meta' }, rarityTag(app, hero), h('span', null, clsText(app, hero))),
    h('p', { class: 'soul-confirm__name' }, hero.name),
    hero.skill ? h('p', { class: 'soul-confirm__skill' }, h('span', { class: 'muted' }, `${t(app, 'drive.skill')} `), hero.skill.name) : null,
    h('p', { class: 'soul-confirm__q' }, fill(t(app, 'drive.soulConfirm'), { name: hero.name })),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn-secondary', type: 'button', onClick: () => closePopup() }, t(app, 'common.cancel')),
      h('button', { class: 'btn-primary', type: 'button', onClick: () => { soulPicking = null; closePopup(); welcome(app, pending, hero); } }, t(app, 'drive.soulPick'))));
  openPopup(body, {
    title: t(app, 'drive.soulTitle'),
    onClose: () => {
      if (soulPicking !== heroId) return;
      soulPicking = null;
      if (wrap && wrap.isConnected) {
        wrap.classList.remove('is-picking');
        for (const c of wrap.querySelectorAll('.soul-card')) c.classList.remove('is-chosen');
      }
    },
  });
}

/** 迎える: souls.accept → カットイン → ヒーローのタブで新しいカードを光らせる */
function welcome(app, pending, hero) {
  const st = app.state;
  let squad;
  try {
    squad = accept(st, app.db, st.playerLand, pending, hero.id);
  } catch (e) {
    console.error(e);
    return;
  }
  save(st);
  soulRevealed = null;
  app.ui.driveTab = 'heroes';
  app.ui.driveNew = squad.id;
  renderApp();
  fx.cutin({ image: hero.image, title: fill(tx(app, 'drive.joinTitle', '{name} が仲間に'), { name: hero.name }), sub: `${t(app, `rarity.${hero.rarity}`)} ・ ${clsText(app, hero)}`, side: 'gold', ms: 1500, se: 'confirm' });
  toast(say(app.db, hero, 'join', { name: hero.name }), { key: 'soul-join', kind: 'good' });
}

function soulSection(app) {
  const st = app.state;
  const list = (st.pending || []).filter((p) => p.kind === 'soul' && p.land === st.playerLand);
  if (!list.length) return null;
  const p = list[0];
  const soul = p.soul || {};
  const key = soulKey(p);
  const shown = soulRevealed === key;
  return h('section', { class: ['soul', shown ? 'is-ready' : null], 'aria-labelledby': 'soul-title', dataset: { key } },
    h('span', { class: 'soul__glow', 'aria-hidden': 'true' }),
    h('header', { class: 'soul__head' },
      h('h2', { class: 'soul__title', id: 'soul-title' }, t(app, 'drive.soulTitle')),
      h('p', { class: 'soul__lead' },
        h('span', { class: 'soul__chip' }, t(app, `cls.${soul.role}`)),
        h('span', { class: 'soul__chip', dataset: { rarity: soul.rarity } }, t(app, `rarity.${soul.rarity}`)),
        list.length > 1 ? h('span', { class: 'soul__left' }, fill(t(app, 'drive.soulLeft'), { n: list.length })) : null)),
    h('div', { class: 'soul__cards' }, (p.candidates || []).map((id, i) => {
      const hero = heroOf(app.db, id);
      if (!hero) return null;
      return h('button', {
        class: ['soul-card', shown ? 'is-up' : 'is-down'], type: 'button', dataset: { rarity: hero.rarity, hero: hero.id },
        style: { '--i': String(i) },
        'aria-label': `${hero.name} ${t(app, `rarity.${hero.rarity}`)} ${clsText(app, hero)}`,
        onClick: (e) => {
          const card = e.currentTarget;
          const wrap = card.closest('.soul');
          // まだ裏向きなら、押したらすぐ全部めくる（選ぶのは表を見てから）
          if (wrap && !wrap.classList.contains('is-ready')) { revealAll(wrap, key); return; }
          pickSoul(app, p, hero.id, card);
        },
      },
      h('span', { class: 'soul-card__back', 'aria-hidden': 'true' },
        h('span', { class: 'soul-card__crest' }, h('span', null, 'SOUL'))),
      h('span', { class: 'soul-card__face' },
        h('span', { class: 'soul-card__shine', 'aria-hidden': 'true' }),
        h('span', { class: 'soul-card__art' }, heroImg(hero, { class: 'soul-card__img', width: 64, height: 64 })),
        h('span', { class: 'soul-card__name' }, hero.name),
        rarityTag(app, hero),
        h('span', { class: 'soul-card__cls' }, clsText(app, hero)),
        paramBars(app, hero, null, { inButton: true }),
        hero.skill ? h('span', { class: 'soul-card__skill' }, hero.skill.name) : null));
    })),
    h('p', { class: 'soul__hint muted' }, tx(app, 'drive.soulHint', '1 枚タップして迎えるヒーローを選ぶ')));
}

/** 裏向きのカードを順にめくる（600ms ずつ）。動きを減らすときはすぐ表 */
function playSoulReveal(sec) {
  const key = sec.dataset.key;
  const cards = [...sec.querySelectorAll('.soul-card')];
  if (!cards.length) return;
  if (fx.reducedMotion()) { revealAll(sec, key); return; }
  const timers = [];
  cards.forEach((c, i) => {
    timers.push(setTimeout(() => {
      if (!c.isConnected || sec.classList.contains('is-ready')) return;
      c.classList.remove('is-down');
      c.classList.add('is-up', 'is-flipping');
      setTimeout(() => c.classList.remove('is-flipping'), SOUL_FLIP_MS);
      if (i === cards.length - 1) {
        timers.push(setTimeout(() => { if (sec.isConnected) markReady(sec, key); }, SOUL_FLIP_MS));
      }
    }, 260 + i * SOUL_FLIP_MS));
  });
  sec._timers = timers;
}

function revealAll(sec, key) {
  for (const id of sec._timers || []) clearTimeout(id);
  for (const c of sec.querySelectorAll('.soul-card')) { c.classList.remove('is-down', 'is-flipping'); c.classList.add('is-up'); }
  markReady(sec, key);
}

function markReady(sec, key) {
  sec.classList.add('is-ready');
  soulRevealed = key;
}

// ------------------------------------------------------------

/** 前回のタブ（タブを替えたら、金の板がすべり中身が横から入る） */
let lastTab = null;

export function render(app) {
  const tab = TABS.includes(app.ui.driveTab) ? app.ui.driveTab : 'heroes';
  app.ui.driveTab = tab;
  const body = tab === 'heroes' ? heroesTab(app) : tab === 'forts' ? fortsTab(app) : landsTab(app);
  const guide = firstGuide(app, { name: 'drive', face: 'point', text: tx(app, 'drive.guide', 'ここはデータベース。ヒーローの強さは 6 つのパラメーターで決まるよ。名前の横の「?」で意味を読めるからね') });
  const ti = TABS.indexOf(tab);
  const root = h('section', { class: 'app-screen app-screen--drive drive' },
    appHead(app, { title: t(app, 'app.drive'), sub: t(app, 'drive.title'), help: () => openHelp(app), back: () => go('home') }),
    guide ? guide.el : null,
    soulSection(app),
    h('div', { class: 'tabs tabs--slide', role: 'tablist', 'aria-label': t(app, 'drive.title'), style: { '--i': String(ti), '--n': String(TABS.length) } },
      h('span', { class: 'tabs__ind', 'aria-hidden': 'true' }),
      TABS.map((k) => h('button', {
        class: ['tab', k === tab ? 'is-active' : null], type: 'button', role: 'tab', id: `drive-tab-${k}`,
        'aria-selected': k === tab ? 'true' : 'false', 'aria-controls': 'drive-panel', tabindex: k === tab ? '0' : '-1',
        onClick: () => { if (app.ui.driveTab !== k) { app.ui.driveTab = k; renderApp(); } },
        onKeydown: (e) => {
          if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
          const i = TABS.indexOf(k) + (e.key === 'ArrowRight' ? 1 : -1);
          app.ui.driveTab = TABS[(i + TABS.length) % TABS.length];
          renderApp();
          const b = document.getElementById(`drive-tab-${app.ui.driveTab}`);
          if (b) b.focus();
        },
      }, t(app, TAB_KEY[k])))),
    h('div', { class: 'tab-panel', role: 'tabpanel', id: 'drive-panel', 'aria-labelledby': `drive-tab-${tab}`, dataset: { tab } }, body));
  root._guide = guide;
  return root;
}

export function mount(app, el) {
  if (!el) return;
  const enter = entering('drive');
  const tab = app.ui.driveTab;
  const prevTab = lastTab;
  lastTab = tab;
  const tabChanged = !enter && prevTab && prevTab !== tab;
  if (el._guide) el._guide.start();
  // タブ: 金の板が前のタブからすべってくる・中身が横から入る
  if (tabChanged) {
    const dir = TABS.indexOf(tab) > TABS.indexOf(prevTab) ? 1 : -1;
    const ind = el.querySelector('.tabs__ind');
    if (ind && ind.animate && !fx.reducedMotion()) {
      const d = TABS.indexOf(prevTab) - TABS.indexOf(tab);
      ind.animate([{ transform: `translateX(${d * 100}%)` }, { transform: 'translateX(0)' }], { duration: fx.token('--t-ui', 240) * 1.25, easing: 'cubic-bezier(.34, 1.3, .64, 1)' });
    }
    const panel = el.querySelector('.tab-panel');
    if (panel) fx.slideIn(panel, dir, { distance: 36 });
  }
  const panel = el.querySelector('.tab-panel');
  // 入ってきた / タブを替えたときだけ、棒が伸び・数字が転がり・カードが順に出る
  if (enter || tabChanged) {
    el.classList.add('is-enter');
    setTimeout(() => el.classList.remove('is-enter'), 1600);
    if (!fx.reducedMotion()) {
      for (const n of panel.querySelectorAll('.param-bar__num')) fx.rollNumber(n, Number(n.dataset.to), { from: 0, flash: false, ms: 700 });
    }
    if (tab === 'forts') fx.stagger(panel.querySelectorAll('.fort-card'), { step: 40, from: 'left', distance: 16 });
    if (tab === 'lands') fx.stagger(panel.querySelectorAll('.land-table tbody tr'), { step: 60, from: 'up', distance: 10 });
    if (tab === 'heroes') fx.stagger(panel.querySelectorAll('.hero-card'), { step: 80, from: 'up', distance: 18, ms: 520 });
  }
  // SOUL: 裏向きの 3 枚が順にめくれる
  const sec = el.querySelector('.soul:not(.is-ready)');
  if (sec) playSoulReveal(sec);
  // 迎えたばかりのヒーロー
  if (app.ui.driveNew) {
    const card = el.querySelector(`.hero-card[data-squad="${app.ui.driveNew}"]`);
    app.ui.driveNew = null;
    if (card) {
      card.classList.add('is-new');
      if (card.scrollIntoView) card.scrollIntoView({ block: 'nearest' });
    }
  }
}

export function unmount(app, el) {
  if (el) {
    const sec = el.querySelector('.soul');
    if (sec) for (const id of sec._timers || []) clearTimeout(id);
  }
  if (app && app.ui.app !== 'drive') {
    leave('drive');
    lastTab = null;
    // 案内を一度出したら、離れた時点で見たことにする
    if (el && el._guide) markGuideSeen('drive');
    // 迎えたときのカットインは、別のアプリへ移ったら早送りで閉じる
    for (const c of document.querySelectorAll('.fx-cutin')) c.dispatchEvent(new Event('pointerdown'));
  }
}
