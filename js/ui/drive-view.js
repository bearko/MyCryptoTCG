// drive-view.js — MCH Drive（SPEC-111 §6・SPEC-112 §5）
//
// タブ: ヒーロー / 砦とエネミー / ランド（app.ui.driveTab）。タブは金の板が横にすべり、中身は横から入る。
// ヒーローのカードは絵を大きく、名前の「裏」に絵が少しはみ出す（SPEC-112 B）。レアリティは縁の色と光沢。
// 一覧は畳んだ形（兵とスキルだけ）で並び、タップで開く（240ms）。開くと棒が左から伸び、数字が転がる。
// 用語の「?」は見出しの横に 1 つだけ（押すと 6 項目の説明）。
// SOUL の選択（pending.kind === "soul"）はここ: 3 枚が裏向きで出て、順にめくれる（600ms ずつ）。
// 1 枚タップ → そのカードが前に出てほかは下がる → 確認 → souls.accept → カットインで迎える。
// 選択待ちがあるときは、ナビの案内パネルを出さず SOUL の見出しの横に 1 行だけ（全文は「?」）。主役の 3 枚を押し下げない。
// 数値（装備込みのパラメーター・兵の上限・射程）は heroes.js に聞く。占領数は season.tileCount と同じ数え方を
// 探索済みのタイルに絞って数える（見えていない所は数えない）。
//
// SPEC-114 §6（Phase 3B）:
// ・ヒーローのカードに士気（ゲージと数字・動揺 / 逃走の言葉）と食費（−N/日）。食費は economy.breakdown の部隊ごとの行、
//   今夜の士気の変化と逃走は内訳シートと同じ見方（積んだ指示のあとの写しを morale.planNight にかける）。
//   恩賞の見込みは economy.previewDomestic。強さへの効きは morale.moraleMult。UI で計算し直さない。
// ・ランドのタブは順位表。値は朝の時点で固定（その日に初めて描いたときに控え、実行フェーズの途中では描き直さない）。
//   視界に一度も入っていないランドの兵・占領マス・ヒーロー数は「?」（値そのものを控えに残さない）。
//   見えたランドの値は「あなたに見えている分」（マップに描かれる部隊・マスの合計。ホームの脅威も landIntel で同じ値を読む）。
//   全部は見えていないランドは「〜」と最後に見た日（「きょう」「3 日前」）。
//   初めは「砦 pt」と「兵」の 2 列。並べ替えのボタンで 兵 / 占領マス に切り替える。
// ・用語の「?」に 士気・食費・配給・恩賞・逃走。文の中の数はエンジンの定数を差し込む（書き写さない）。

import { h, heroImg, imgEl, landAssetPath, toast } from './h.js';
import { uiText, say } from '../engine/lines.js';
import { effectiveParams, troopCap, rangeOf, PARAM_KEYS } from '../engine/heroes.js';
import { breakdown, previewDomestic, totalTroops } from '../engine/economy.js';
import { planNight, moraleOf, moraleMult, rationOf, MORALE_SHAKEN, MORALE_DELTA, RATIONS, DESERT_RATE, REWARD_BASE, REWARD_PER_TROOPS } from '../engine/morale.js';
import { TROOPS_PER_FOOD } from '../engine/tuning.js';
import { tileCount } from '../engine/season.js';
import { moraleGauge, plannedState, openLedger, signed, fmt } from './ledger-view.js';
import { accept } from '../engine/souls.js';
import { save } from '../state.js';
import { render as renderApp, openPopup, closePopup, go } from '../main.js';
import { appHead, helpPopup, firstGuide, markGuideSeen, entering, leave, tx } from './app-kit.js';
import * as fx from './fx.js';

const TABS = ['heroes', 'forts', 'lands'];
const TAB_KEY = { heroes: 'drive.tabHeroes', forts: 'drive.tabForts', lands: 'driveP3.tabRank' };
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
  return params.concat(more, moraleTerms(app));
}

/** 士気まわりの用語（SPEC-114 §8）。文の中の数はエンジンの定数から差し込む */
const MORALE_TERMS = ['morale', 'foodCost', 'ration', 'reward', 'desert'];
const MORALE_TERM_FALLBACK = {
  morale: ['士気', '部隊ごとの 0〜100。攻撃と防御に掛かります（0 で ×{m0}、50 で ×{m50}、100 で ×{m100}）。{shaken} 未満は動揺。食料が足りた夜は {fed}、本拠地で夜を越すと {home}、食料が尽きた夜は全部隊が {starve}'],
  foodCost: ['食費', 'その部隊の兵が 1 日に食べる食料。兵 {d} 人で 1（配給で増減）。人口の分は別に引かれます'],
  ration: ['配給', 'ランドの方針。節約は兵の食料 ×{saveFood} で士気が毎日 {saveMorale}、増量は ×{feastFood} で毎日 {feastMorale}。AP を使わずに、内訳シートの食料のタブで切り替えます'],
  reward: ['恩賞', '本拠地での内政（AP 2）。GUM {rewardBase} と、兵 {rewardPer} 人ごとに 1 を払って、その部隊の士気 {reward}'],
  desert: ['逃走', '士気 0 のまま夜を迎えた部隊から、兵の {pct}%（切り上げ）が逃げます。逃げた兵は戻りません'],
};

function moraleTermVars() {
  return {
    m0: moraleMult(0).toFixed(2), m50: moraleMult(50).toFixed(2), m100: moraleMult(100).toFixed(2), shaken: MORALE_SHAKEN,
    fed: signed(MORALE_DELTA.fed), home: signed(MORALE_DELTA.home), starve: signed(MORALE_DELTA.starve), reward: signed(MORALE_DELTA.reward),
    d: TROOPS_PER_FOOD, saveFood: RATIONS.save.food, saveMorale: signed(RATIONS.save.morale), feastFood: RATIONS.feast.food, feastMorale: signed(RATIONS.feast.morale),
    rewardBase: REWARD_BASE, rewardPer: REWARD_PER_TROOPS, pct: Math.round(DESERT_RATE * 100),
  };
}

function moraleTerms(app) {
  const vars = moraleTermVars();
  return MORALE_TERMS.map((id) => ({
    id,
    term: tx(app, `driveP3.term.${id}`, MORALE_TERM_FALLBACK[id][0]),
    text: fill(tx(app, `driveP3.term.${id}.text`, MORALE_TERM_FALLBACK[id][1]), vars),
  }));
}

/** 初回の案内（SOUL の選択待ちでは出さないので、その全文は「?」の頭に回す） */
function guideText(app) {
  return tx(app, 'drive.guideFold', 'ここはデータベース。ヒーローのカードを押すと、強さを決める 6 つのパラメーターが開くよ。意味は「?」で読めるからね');
}

export function openHelp(app, focus) {
  const lead = [app.ui && app.ui.driveGuideInHelp ? guideText(app) : null, tx(app, 'help.driveLead', '')].filter(Boolean).join('\n');
  helpPopup(app, { title: tx(app, 'help.driveTitle', '用語の説明'), lead, items: termItems(app), focus });
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
      h('dt', null, opts.plain ? h('span', { class: 'term term--plain' }, t(app, `param.${k}`)) : term(app, k, t(app, `param.${k}`), opts.inButton)),
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

/** 開いているヒーローのカード（描き直しても残す） */
function openSet(app) {
  if (!app.ui.driveOpen || typeof app.ui.driveOpen !== 'object') app.ui.driveOpen = {};
  return app.ui.driveOpen;
}

/** カードを開く / 畳む（DOM を直接切り替える。描き直しはしない） */
function toggleCard(app, card) {
  const id = card.dataset.squad;
  const open = !card.classList.contains('is-open');
  openSet(app)[id] = open;
  card.classList.toggle('is-open', open);
  const btn = card.querySelector('.hero-card__toggle');
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (!open || fx.reducedMotion()) return;
  // 開いたときだけ、棒が伸びて数字が転がる（押したら必ず何かが返る）
  for (const g of card.querySelectorAll('.param-bar__grow')) {
    if (g.animate) g.animate([{ transform: 'scaleX(0)' }, { transform: 'none' }], { duration: 560, delay: 90 + Number(g.parentNode.parentNode.parentNode.style.getPropertyValue('--j') || 0) * 40, easing: 'cubic-bezier(.16, 1, .3, 1)', fill: 'backwards' });
  }
  for (const n of card.querySelectorAll('.param-bar__num')) fx.rollNumber(n, Number(n.dataset.to), { from: 0, flash: false, ms: 520 });
}

/**
 * 士気と食費の見込み（描くたびに 1 回だけエンジンに聞く）。
 *   food   … economy.breakdown の食料の支出のうち、部隊ごとの兵の行（積んだ指示を含まない。内訳シートと同じ数）
 *   night  … 積んだ指示のあとで今夜を迎えたら（morale.planNight。飢えるかは forecast と同じ決め方）。内訳シートと同じ見方
 */
function moraleContext(app) {
  const st = app.state;
  const me = st.playerLand;
  const base = breakdown(st, app.db, me);
  const food = new Map(base.food.expense.filter((r) => r.key === 'troops').map((r) => [r.squad, r.value]));
  const sim = plannedState(app);
  const sb = breakdown(sim, app.db, me);
  const night = planNight(sim, app.db, me, sb.food.stock + sb.food.net < 0, 0);
  return {
    food,
    tonight: new Map(night.morale.map((x) => [x.squad, x.delta])),
    desert: new Map(night.desert.map((x) => [x.squad, x.amount])),
    ration: rationOf(st.lands[me]),
  };
}

/** 士気の状態の言葉（色だけに頼らない）。null は平常 */
function moraleState(app, squad, mc) {
  const m = moraleOf(squad);
  const des = mc.desert.get(squad.id) || 0;
  if (squad.status === 'routed') return null; // 敗走中は別のタグで出す
  if (des > 0) return { level: 'bad', text: fill(tx(app, 'driveP3.desertTonight', '逃走 今夜 −{n} 人'), { n: fmt(des) }) };
  if (m === 0) return { level: 'warn', text: tx(app, 'driveP3.zeroHold', '士気 0・今夜は逃げない') };
  if (m < MORALE_SHAKEN) return { level: 'warn', text: tx(app, 'driveP3.shaken', '動揺') };
  return null;
}

/** 開いた形の「士気と食費」。強さへの効き・今夜の変化・食費・配給・恩賞の見込み。行を押すと動かす画面へ */
function moraleBox(app, squad, hero, mc) {
  const m = moraleOf(squad);
  const food = mc.food.get(squad.id) || 0;
  const tonight = mc.tonight.get(squad.id) || 0;
  const des = mc.desert.get(squad.id) || 0;
  const routed = squad.status === 'routed';
  const rw = routed ? null : previewDomestic(app.state, app.db, squad, 'reward');
  const why = rw && !rw.ok ? tx(app, `driveP3.why.${rw.reason}`, '') : '';
  const pv = (k, fb) => tx(app, k, fb);
  return h('div', { class: 'hero-mor', dataset: { morale: m } },
    // 士気: ゲージ・強さへの効き・今夜の変化
    h('div', { class: 'hero-mor__row' },
      h('span', { class: 'hero-mor__k' }, term(app, 'morale', pv('driveP3.morale', '士気'))),
      moraleGauge(app, m, { cls: 'morale--card' }),
      h('span', { class: 'hero-mor__mult num' }, fill(pv('driveP3.mult', '強さ ×{v}'), { v: moraleMult(m).toFixed(2) }))),
    h('p', { class: 'hero-mor__sub' },
      routed ? h('span', null, pv('driveP3.routedNight', '敗走中は夜の士気の変化を受けません'))
        : h('span', { class: ['num', tonight > 0 ? 'is-up' : tonight < 0 ? 'is-down' : null] }, fill(pv('driveP3.tonight', '今夜の士気 {v}'), { v: signed(tonight) })),
      des > 0 ? h('strong', { class: 'hero-mor__bad num' }, fill(pv('driveP3.desertTonight', '逃走 今夜 −{n} 人'), { n: fmt(des) })) : null,
      h('span', { class: 'hero-mor__note' }, term(app, 'desert', pv('driveP3.term.desert', '逃走')),
        fill(pv('driveP3.desertRule', '士気 0 で夜を越すと 兵 −{pct}%'), { pct: Math.round(DESERT_RATE * 100) }))),
    // 食費と配給（押すと内訳シートの食料。配給はそこで切り替える）
    h('div', { class: 'hero-mor__row hero-mor__row--food' },
      h('span', { class: 'hero-mor__k' }, term(app, 'foodCost', pv('driveP3.food', '食費'))),
      h('button', {
        class: 'hero-mor__link', type: 'button', 'aria-label': `${pv('driveP3.food', '食費')} ${signed(-food)} ${pv('driveP3.perDay', '/日')}、${pv('driveP3.openFood', '内訳を開く')}`,
        onClick: () => openLedger(app, 'food'),
      },
      h('strong', { class: 'num' }, `${signed(-food)}${pv('driveP3.perDay', '/日')}`),
      h('span', { class: 'hero-mor__ration' }, fill(pv('driveP3.ration', '配給 {r}'), { r: pv(`driveP3.ration.${mc.ration}`, mc.ration) })),
      h('span', { class: 'hero-mor__go', 'aria-hidden': 'true' })),
      term(app, 'ration', pv('driveP3.term.ration', '配給'))),
    // 恩賞の見込み（押すとそのヒーローのトーク。積むのは Chat）
    rw && rw.delta.morale > 0 ? h('div', { class: 'hero-mor__row hero-mor__row--reward' },
      h('span', { class: 'hero-mor__k' }, term(app, 'reward', pv('driveP3.term.reward', '恩賞'))),
      h('button', {
        class: ['hero-mor__link', rw.ok ? null : 'is-off'], type: 'button', onClick: () => go('chat', { squad: squad.id }),
      },
      h('span', { class: 'num' }, fill(pv('driveP3.rewardEff', 'GUM {g}・士気 {m}'), { g: signed(rw.delta.gum), m: signed(rw.delta.morale) })),
      h('span', { class: 'hero-mor__why' }, rw.ok ? pv('driveP3.rewardGo', 'トークで積む') : why),
      h('span', { class: 'hero-mor__go', 'aria-hidden': 'true' }))) : null);
}

function heroCard(app, squad, i, mc) {
  const db = app.db;
  const hero = heroOf(db, squad.heroId);
  if (!hero) return null;
  const ms = moraleState(app, squad, mc);
  const m = moraleOf(squad);
  const food = mc.food.get(squad.id) || 0;
  const cap = troopCap(hero, squad, db);
  const ext = squad.equip ? db.extensions[squad.equip] : null;
  const pct = cap ? Math.max(0, Math.min(100, (squad.troops / cap) * 100)) : 0;
  const open = !!openSet(app)[squad.id];
  const bodyId = `hero-body-${squad.id}`;
  const s = hero.skill;
  return h('article', {
    class: ['hero-card', squad.status === 'routed' ? 'is-routed' : null, open ? 'is-open' : null],
    dataset: { rarity: hero.rarity, squad: squad.id }, style: { '--i': String(i) },
  },
  // 光沢と縁（カードの形に切り抜く層。絵は切り抜かずに上へはみ出す）
  h('span', { class: 'hero-card__skin', 'aria-hidden': 'true' }, h('span', { class: 'hero-card__gloss' })),
  // 絵は名前の「裏」（文字が手前に重なる）
  h('span', { class: 'hero-card__art', 'aria-hidden': 'true' },
    h('span', { class: 'hero-card__halo' }),
    heroImg(hero, { class: 'hero-card__img', width: 128, height: 128, alt: '' })),
  // 畳んだ形: レアリティ・名前・兵・スキル名だけ。押すと開く
  h('button', {
    class: 'hero-card__toggle', type: 'button', 'aria-expanded': open ? 'true' : 'false', 'aria-controls': bodyId,
    onClick: (e) => toggleCard(app, e.currentTarget.closest('.hero-card')),
  },
  h('span', { class: 'hero-card__meta' }, rarityTag(app, hero), h('span', { class: 'hero-card__cls' }, clsText(app, hero)),
    squad.status === 'routed' ? h('span', { class: 'tag tag--danger' }, t(app, 'map.routed')) : null,
    ms ? h('span', { class: ['mor-tag', `is-${ms.level}`] }, ms.text) : null),
  h('span', { class: 'hero-card__name', role: 'heading', 'aria-level': '3' }, hero.name),
  h('span', { class: 'hero-card__sum num' },
    h('span', { class: 'stat' },
      h('span', { class: 'stat__label' }, t(app, 'param.troops')),
      h('span', { class: 'stat__val' }, h('b', null, String(squad.troops)), h('small', null, ` / ${cap}`)),
      h('span', { class: 'stat__bar', 'aria-hidden': 'true' }, h('span', { class: 'stat__fill', style: { width: `${pct}%` } }))),
    // 士気（ゲージと数字）と食費（−N/日）
    h('span', { class: 'hero-card__mor' },
      h('span', { class: 'stat__label' }, tx(app, 'driveP3.morale', '士気')),
      moraleGauge(app, m, { cls: 'morale--sum' }),
      h('span', { class: 'hero-card__food' },
        h('span', { class: 'stat__label' }, tx(app, 'driveP3.food', '食費')),
        h('b', null, `${signed(-food)}`), h('small', null, tx(app, 'driveP3.perDay', '/日')))),
    s ? h('span', { class: 'hero-card__skill-chip' },
      h('span', { class: 'skill-kind', dataset: { kind: s.kind } }, t(app, `skill.${s.kind}`)),
      h('span', { class: 'hero-card__skill-name' }, s.name)) : null)),
  // 開いた形: 射程・6 つのパラメーター（「?」は見出しの横に 1 つ）・スキル・エクステンション
  h('div', { class: 'hero-card__more', id: bodyId },
    h('div', { class: 'hero-card__more-in' },
      moraleBox(app, squad, hero, mc),
      h('div', { class: 'hero-card__params-head' },
        h('span', { class: 'hero-card__params-title' }, tx(app, 'drive.params', '能力値')),
        h('button', {
          class: 'hero-card__q', type: 'button', 'aria-label': `${tx(app, 'drive.params', '能力値')} ${tx(app, 'help.title', '説明')}`,
          onClick: (e) => { e.stopPropagation(); openHelp(app, 'act'); },
        }, h('span', { 'aria-hidden': 'true' }, '?')),
        h('span', { class: 'stat hero-card__range num' },
          h('span', { class: 'stat__label' }, t(app, 'drive.range')),
          h('span', { class: 'stat__val' }, h('b', null, String(rangeOf(hero)))))),
      paramBars(app, hero, squad, { plain: true }),
      h('footer', { class: 'hero-card__foot' },
        skillLine(app, hero),
        h('div', { class: 'hero-card__equip' },
          h('span', { class: 'hero-card__equip-label' }, t(app, 'drive.equip')),
          ext
            ? h('button', { class: 'hero-card__ext', type: 'button', onClick: () => go('photo') },
              imgEl(ext.image, ext.name, { class: 'hero-card__ext-img', width: 28, height: 28 }),
              h('span', { class: 'hero-card__ext-name' }, ext.name), h('small', null, ext.text))
            : h('button', { class: 'hero-card__ext is-empty', type: 'button', onClick: () => go('photo') },
              h('span', { class: 'hero-card__ext-slot', 'aria-hidden': 'true' }), h('span', null, t(app, 'drive.noEquip'))))))),
  // 開く印（カードの下の縁に掛かったつまみ。開くと上を向く）
  h('span', { class: 'hero-card__chev', 'aria-hidden': 'true' }));
}

function heroesTab(app) {
  const st = app.state;
  const mine = Object.values(st.squads || {}).filter((s) => s.land === st.playerLand);
  if (!mine.length) return h('p', { class: 'empty muted' }, t(app, 'chat.noSquads'));
  const mc = moraleContext(app);
  return h('div', { class: 'hero-list' }, mine.map((s, i) => heroCard(app, s, i, mc)));
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
  // 分かっている砦（よそ）→ 自ランドの砦 → 未探索。その中はランクの高い順
  const group = (f) => (!seen.has(f.tile) ? 2 : f.owner === st.playerLand ? 1 : 0);
  const forts = Object.values(st.forts || {}).sort((a, b) => (group(a) - group(b)) || (order[a.rank] - order[b.rank]) || String(a.id).localeCompare(String(b.id), 'en', { numeric: true }));
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
          // 名前にランクが入っている（「Rare砦 …」）ので、前にランクを重ねない。色だけランクの色
          h('h3', { class: 'fort-card__name fort-rank' }, f.name),
          // 持ち主とエネミーは 2 行に分ける（名前が途中で折れないように）
          h('p', { class: 'fort-card__meta fort-card__row' }, h('span', { class: 'fort-card__k muted' }, t(app, 'map.owner')),
            h('span', { class: 'fort-card__owner' }, landName(app, f.owner)), own ? h('span', { class: 'fort-card__mine' }, tx(app, 'drive.mine', '自ランド')) : null),
          enemy ? h('p', { class: 'fort-card__meta fort-card__row' }, h('span', { class: 'fort-card__k muted' }, t(app, 'drive.enemy')),
            h('span', { class: 'fort-card__enemy' }, enemy.name)) : null,
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

/** 順位表の並べ替え（初めは砦 pt。表に出す 2 列は [並べ替えた値, もう 1 つ]） */
const RANK_VIEWS = ['fp', 'troops', 'tiles'];
const RANK_COLS = { fp: ['fp', 'troops'], troops: ['troops', 'ratio'], tiles: ['tiles', 'heroes'] };
const RANK_FALLBACK = {
  fp: '砦 pt', troops: '兵', tiles: '占領マス', heroes: 'ヒーロー', ratio: 'あなたの',
};

/** ゲームごとの朝の控え（state → { day, rows, known, sighted }）。セーブには入れない */
const rankSnaps = new WeakMap();

/**
 * 順位表の控え。その日に初めて描いたとき（= 朝。指示は夜まで実行されない）に作り、同じ日のうちは作り直さない。
 * 実行フェーズの途中（state が動いている）では、前の控えをそのまま使う（ターンの途中で数字を当てられないように）。
 *
 * よそのランドの数は「あなたに見えている分」だけ（マップに描かれている部隊・マスと同じ。ホームの脅威もこの値）:
 *   兵       … そのランドの部隊のうち、探索済みのタイルにいる部隊の兵の合計
 *   ヒーロー … 同じく、見えている部隊の数
 *   占領マス … 探索済みのタイルのうち、そのランドの持ち物の数
 * 全部が見えていないランド（見えていない部隊・マスがある）は part を立て、画面では「〜」を付ける。
 * きょう部隊が 1 つも見えないランドは、最後に部隊が見えた日の兵とヒーローを出す（「〜」と「N 日前」。控えはゲーム中だけ）。
 * 視界に一度も入っていないランド（探索済みのタイルに、そのランドのタイルも部隊も無かった）は、値を控えに残さない。
 * 自ランドは全部見えているので、エンジンの値そのまま（兵 = economy.totalTroops、占領マス = season.tileCount）。
 * 砦 pt は日曜の集計で全ランドに知らされる値なので、いつも出す。
 */
function rankSnapshot(app) {
  const st = app.state;
  const prev = rankSnaps.get(st);
  if (prev && (prev.day === st.day || app.ui.executing)) return prev;
  const me = st.lands[st.playerLand];
  const seen = new Set(me.explored || []);
  const tiles = st.map.tiles;
  const known = new Set(prev ? prev.known : []);
  const sighted = new Map(prev ? prev.sighted : []); // land → { day, troops, heroes }（最後に部隊が見えた朝）
  known.add(st.playerLand);
  const vis = {}; // land → { troops, heroes, tiles, allSquads, allTiles }
  const at = (id) => (vis[id] || (vis[id] = { troops: 0, heroes: 0, tiles: 0, allSquads: 0, allTiles: 0 }));
  tiles.forEach((tl, i) => {
    const o = tl && tl.owner;
    if (!o) return;
    const v = at(o);
    v.allTiles++;
    if (seen.has(i)) { v.tiles++; known.add(o); }
  });
  for (const s of Object.values(st.squads || {})) {
    const v = at(s.land);
    v.allSquads++;
    if (!seen.has(s.tile)) continue;
    v.heroes++;
    v.troops += s.troops || 0;
    known.add(s.land);
  }
  const rows = (app.db.lands || []).filter((l) => st.lands[l.id]).map((l) => {
    const land = st.lands[l.id];
    const mine = l.id === st.playerLand;
    const k = known.has(l.id);
    const v = at(l.id);
    const row = {
      id: l.id, def: l, me: mine, alive: land.alive !== false, known: k,
      fp: land.fortPoints || 0,
      // 見ていないランドの値は控えに入れない（DOM にも出さない）
      troops: null, heroes: null, tiles: null, part: false, tilesPart: false, seenDay: null,
    };
    if (mine) return { ...row, troops: totalTroops(st, l.id), heroes: v.allSquads, tiles: tileCount(st, l.id) };
    if (!k) return row;
    row.tiles = v.tiles;
    row.tilesPart = v.tiles < v.allTiles;
    if (v.heroes > 0) {
      sighted.set(l.id, { day: st.day, troops: v.troops, heroes: v.heroes });
      return { ...row, troops: v.troops, heroes: v.heroes, part: v.heroes < v.allSquads, seenDay: st.day };
    }
    const last = sighted.get(l.id);
    // きょうは部隊が 1 つも見えない: 最後に見た朝の値。一度も見ていなければ「?」
    if (last) return { ...row, troops: last.troops, heroes: last.heroes, part: true, seenDay: last.day };
    // 脱落したランドは部隊が無いと知らされている
    if (!row.alive) return { ...row, troops: 0, heroes: 0 };
    return row;
  });
  const snap = { day: st.day, rows, known: [...known], sighted: [...sighted] };
  rankSnaps.set(st, snap);
  return snap;
}

/**
 * よそのランドの「見えている兵」（順位表と同じ値。ホームの脅威・マップと数字をそろえるための入口）。
 * @returns {null | { troops:number, part:boolean, seenDay:number|null, day:number }} 見たことが無いランドは null
 */
export function landIntel(app, landId) {
  const snap = rankSnapshot(app);
  const r = snap.rows.find((x) => x.id === landId);
  if (!r || r.troops == null) return null;
  return { troops: r.troops, part: r.part, seenDay: r.seenDay, day: snap.day };
}

/** 並べ替えた値で順位を振る（同じ値は同じ順位。値の分からないランドは順位なしで下へ） */
function rankRows(snap, key) {
  const val = (r) => r[key];
  const has = (r) => val(r) != null;
  const list = [...snap.rows].sort((a, b) => (has(b) - has(a)) || ((val(b) || 0) - (val(a) || 0)) || (b.me - a.me));
  return list.map((r) => ({ ...r, rank: has(r) ? 1 + snap.rows.filter((x) => has(x) && val(x) > val(r)).length : null }));
}

function rankLabel(app, k) {
  return tx(app, `driveP3.rank.col.${k}`, RANK_FALLBACK[k]);
}

/** その列の値が「見えている分だけ」か（よそのランドの兵・ヒーロー・占領マス） */
function isPart(r, col) {
  if (col === 'tiles') return !!r.tilesPart;
  if (col === 'troops' || col === 'heroes' || col === 'ratio') return !!r.part;
  return false;
}

/** 見えている分だけの値の頭に付ける「〜」 */
function approx(app, part) {
  return part ? tx(app, 'driveP3b.rank.approx', '〜') : '';
}

/** 最後に見た日（「きょう」「3 日前」。順位表は朝の値なので、控えた朝から数える） */
function seenText(app, snap, day) {
  const n = Math.max(0, snap.day - day);
  return n === 0 ? tx(app, 'driveP3b.rank.seenToday', 'きょう') : fill(tx(app, 'driveP3b.rank.seenAgo', '{n} 日前'), { n });
}

/** 「何倍」の桁（ホームの脅威・マップの札と同じ丸め方） */
function ratioText(x) {
  return x >= 10 ? x.toFixed(0) : x >= 1 ? x.toFixed(1) : x.toFixed(2);
}

/** 自分の順位の 1 行（順位と差。SPEC-114 原則 8）。よそが見えている分だけなら、そう書く */
function rankSummary(app, rows, key) {
  const me = rows.find((r) => r.me);
  if (!me || me.rank == null) return null;
  const knownN = rows.filter((r) => r[key] != null).length;
  const others = rows.filter((r) => !r.me && r[key] != null);
  const best = (list) => list.reduce((a, r) => (!a || r[key] > a[key] ? r : a), null);
  let gap = '';
  if (me.rank > 1) {
    const top = best(others);
    gap = fill(tx(app, 'driveP3.rank.toTop', '1 位まで {v}'), { v: `${approx(app, isPart(top, key))}${signed(me[key] - top[key])}` });
  } else if (others.length) {
    const second = best(others);
    gap = me[key] > second[key]
      ? fill(tx(app, 'driveP3.rank.lead', '2 位と {v}'), { v: `${approx(app, isPart(second, key))}${signed(me[key] - second[key])}` })
      : tx(app, 'driveP3.rank.tie', '1 位に並ぶ');
  }
  const notes = [];
  if (key !== 'fp' && knownN < rows.length) notes.push(fill(tx(app, 'driveP3.rank.of', '分かっている {n} ランドの中'), { n: knownN }));
  if (others.some((r) => isPart(r, key))) notes.push(tx(app, 'driveP3b.rank.partSum', '〜 は見えている分だけ'));
  return h('p', { class: 'rank-sum num' },
    h('span', { class: 'rank-sum__pos' }, fill(tx(app, 'driveP3.rank.you', 'あなた {n} 位'), { n: me.rank })),
    h('span', { class: 'rank-sum__val' }, `${rankLabel(app, key)} ${fmt(me[key])}`),
    gap ? h('span', { class: 'rank-sum__gap' }, gap) : null,
    notes.length ? h('span', { class: 'rank-sum__of muted' }, notes.join('・')) : null);
}

/** 「?」（色だけに頼らず、読み上げでは「まだ見ていない」） */
function unknownCell(app) {
  return h('span', { class: 'rank-q', 'aria-label': tx(app, 'driveP3.rank.unknown', 'まだ見ていない') }, '?');
}

/**
 * 値のセルの中身。全部は見えていないランドは「〜982」と、その下に最後に見た日（兵・ヒーロー・何倍。占領マスはいまの地図なので日は付けない）。
 * 「〜」は色ではなく字で示し、読み上げでは「見えている分」と言う
 */
function cellValue(app, snap, r, col, text) {
  const part = isPart(r, col);
  if (!part) return [h('span', { class: 'rank-v' }, text)];
  const day = col !== 'tiles' && r.seenDay != null ? seenText(app, snap, r.seenDay) : null;
  const label = `${tx(app, 'driveP3b.rank.partAria', '見えている分')} ${text}${day ? `、${fill(tx(app, 'driveP3b.rank.seenAria', '{d}に見た値'), { d: day })}` : ''}`;
  return [
    h('span', { class: 'rank-v is-part', 'aria-label': label },
      h('span', { class: 'rank-v__approx', 'aria-hidden': 'true' }, approx(app, true)), h('span', { 'aria-hidden': 'true' }, text)),
    day ? h('small', { class: ['rank-v__seen', r.seenDay < snap.day ? 'is-old' : null], 'aria-hidden': 'true' }, day) : null,
  ];
}

function rankCell(app, snap, r, col, top, mine) {
  if (col === 'ratio') {
    if (r.me) return h('td', { class: 'num rank-td__ratio muted' }, tx(app, 'driveP3.rank.self', '-'));
    if (r.troops == null) return h('td', { class: 'num' }, unknownCell(app));
    if (!mine) return h('td', { class: 'num muted' }, '-');
    const x = r.troops / mine;
    return h('td', { class: ['num', 'rank-td__ratio', x > 1 ? 'is-more' : null] },
      cellValue(app, snap, r, col, fill(tx(app, 'driveP3.rank.times', '×{v}'), { v: ratioText(x) })));
  }
  const v = r[col];
  if (v == null) return h('td', { class: 'num' }, unknownCell(app));
  if (top == null) return h('td', { class: 'num' }, cellValue(app, snap, r, col, fmt(v)));
  return h('td', { class: 'num land-table__fp' },
    h('span', { class: 'land-table__fpbar', 'aria-hidden': 'true', style: { '--fp': String(top ? v / top : 0) } }),
    h('span', { class: 'land-table__fpval' }, cellValue(app, snap, r, col, fmt(v))));
}

function landsTab(app) {
  const st = app.state;
  const view = RANK_VIEWS.includes(app.ui.driveRankView) ? app.ui.driveRankView : 'fp';
  app.ui.driveRankView = view;
  const snap = rankSnapshot(app);
  const rows = rankRows(snap, view);
  const [c1, c2] = RANK_COLS[view];
  const top = Math.max(1, ...rows.map((r) => r[c1] || 0));
  const mine = (rows.find((r) => r.me) || {}).troops || 0;
  const today = snap.day === st.day;
  return h('div', { class: 'rank' },
    h('div', { class: 'rank__head' },
      h('p', { class: 'rank__when' },
        h('span', { class: 'rank__day num' }, fill(tx(app, 'driveP3.rank.when', '{n} 日目の朝の時点'), { n: snap.day })),
        h('span', { class: 'muted' }, today ? tx(app, 'driveP3.rank.whenNote', '夜の実行のあとに更新') : tx(app, 'driveP3.rank.whenExec', '実行のあとに更新します'))),
      h('div', { class: 'rank__sort', role: 'group', 'aria-label': tx(app, 'driveP3.rank.sort', '並べ替え') },
        h('span', { class: 'rank__sort-k', 'aria-hidden': 'true' }, tx(app, 'driveP3.rank.sort', '並べ替え')),
        RANK_VIEWS.map((k) => h('button', {
          class: ['rank__sort-btn', k === view ? 'is-on' : null], type: 'button', 'aria-pressed': k === view ? 'true' : 'false', dataset: { view: k },
          onClick: () => { if (app.ui.driveRankView !== k) { app.ui.driveRankView = k; renderApp(); } },
        }, rankLabel(app, k))))),
    rankSummary(app, rows, view),
    h('div', { class: 'land-table-wrap' },
      h('table', { class: 'land-table rank-table', dataset: { view } },
        h('caption', { class: 'muted' }, tx(app, 'driveP3b.rank.note', '兵・ヒーロー・占領マスは、マップに見えている部隊とマスの合計。「〜」は全部は見えていないランドで、下の字は最後に見た日。まだ視界に入っていないランドは「?」')),
        h('thead', null, h('tr', null,
          h('th', { scope: 'col', class: 'rank-th__pos' }, tx(app, 'driveP3.rank.pos', '順位')),
          h('th', { scope: 'col' }, tx(app, 'drive.tabLands', 'ランド')),
          h('th', { scope: 'col', class: 'is-sorted' }, c1 === 'fp' ? term(app, 'fortPoints', rankLabel(app, c1)) : rankLabel(app, c1)),
          h('th', { scope: 'col' }, c2 === 'ratio' ? tx(app, 'driveP3.rank.col.ratioHead', 'あなたの何倍') : rankLabel(app, c2)))),
        h('tbody', null, rows.map((r, i) => h('tr', {
          class: [r.me ? 'is-me' : null, r.alive ? null : 'is-out', r.known ? null : 'is-unknown', isPart(r, c1) || isPart(r, c2) ? 'is-part' : null],
          dataset: { land: r.id, rank: r.rank == null ? '' : String(r.rank) },
          style: { '--land': r.def.color, '--i': String(i) },
        },
        h('td', { class: 'num rank-td__pos' }, r.rank == null ? unknownCell(app) : String(r.rank)),
        h('th', { scope: 'row' },
          h('span', { class: 'land-cell' },
            imgEl(landAssetPath(r.def.icon), r.def.nameJa || r.def.name, { class: 'land-cell__icon', width: 24, height: 24 }),
            h('span', { class: 'land-cell__name' }, r.def.nameJa || r.def.name),
            r.me ? h('span', { class: 'land-cell__you' }, tx(app, 'driveP3.rank.youTag', 'あなた')) : null,
            r.alive ? null : h('span', { class: 'land-cell__out' }, tx(app, 'driveP3.rank.out', '脱落')))),
        rankCell(app, snap, r, c1, top, mine),
        rankCell(app, snap, r, c2, null, mine)))))));
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
  // 自ランドの兵が増えたので、順位表の控えを取り直す（よそのランドは夜まで動かないので、朝の値のまま）
  const snap = rankSnaps.get(st);
  if (snap) snap.day = null;
  app.ui.driveTab = 'heroes';
  app.ui.driveNew = squad.id;
  renderApp();
  fx.cutin({ image: hero.image, title: fill(tx(app, 'drive.joinTitle', '{name} が仲間に'), { name: hero.name }), sub: `${t(app, `rarity.${hero.rarity}`)} ・ ${clsText(app, hero)}`, side: 'accent', ms: 1500, se: 'confirm' });
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
  const sec = h('section', { class: ['soul', shown ? 'is-ready' : null], 'aria-labelledby': 'soul-title', dataset: { key } },
    h('span', { class: 'soul__glow', 'aria-hidden': 'true' }),
    h('header', { class: 'soul__head' },
      h('h2', { class: 'soul__title', id: 'soul-title' }, t(app, 'drive.soulTitle')),
      // 案内は見出しの横の 1 行だけ（全文は右上の「?」）
      h('p', { class: 'soul__hint', 'aria-live': 'polite' },
        h('span', { class: 'soul__hint-dot', 'aria-hidden': 'true' }),
        shown ? tx(app, 'drive.soulHintShort', '1 枚タップして選ぶ') : tx(app, 'drive.soulHintWait', 'SOUL をめくっています')),
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
      // 回るのは中の板（__inner）。ボタン自身は perspective を持ち、床の影（::before）は回らない
      h('span', { class: 'soul-card__inner' },
      h('span', { class: 'soul-card__edge', 'aria-hidden': 'true' }),
      h('span', { class: 'soul-card__back', 'aria-hidden': 'true' },
        h('span', { class: 'soul-card__crest' }, h('span', null, 'SOUL'))),
      h('span', { class: 'soul-card__face' },
        h('span', { class: 'soul-card__flash', 'aria-hidden': 'true' }),
        h('span', { class: 'soul-card__shine', 'aria-hidden': 'true' }),
        h('span', { class: 'soul-card__art' }, heroImg(hero, { class: 'soul-card__img', width: 64, height: 64 })),
        h('span', { class: 'soul-card__name' }, hero.name),
        rarityTag(app, hero),
        h('span', { class: 'soul-card__cls' }, clsText(app, hero)),
        paramBars(app, hero, null, { inButton: true }),
        hero.skill ? h('span', { class: 'soul-card__skill' }, hero.skill.name) : null)));
    })));
  sec._readyText = tx(app, 'drive.soulHintShort', '1 枚タップして選ぶ');
  return sec;
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
  const hint = sec.querySelector('.soul__hint');
  if (hint && sec._readyText) {
    hint.lastChild.textContent = sec._readyText;
    if (hint.animate && !fx.reducedMotion()) hint.animate([{ opacity: 0, transform: 'translateX(-6px)' }, { opacity: 1, transform: 'none' }], { duration: 240, easing: 'cubic-bezier(.16, 1, .3, 1)' });
  }
}

// ------------------------------------------------------------

/**
 * 吹き出しの高さを、全文が出たときの高さで先に確保する（1 文字ずつ出ても下の配置が動かない）。
 * 差した直後（まだ全文が入っている）に測る。
 */
export function lockGuide(guideEl) {
  const b = guideEl && guideEl.querySelector('.navi-bubble');
  if (!b || !b.offsetHeight) return;
  b.style.minHeight = `${b.offsetHeight}px`;
  b.style.width = `${b.offsetWidth}px`;
  b.style.boxSizing = 'border-box';
}

/** 前回のタブ（タブを替えたら、金の板がすべり中身が横から入る） */
let lastTab = null;
/** 前回の順位表の並べ替え（替えたら行が順に入り直す） */
let lastRankView = null;

export function render(app) {
  const tab = TABS.includes(app.ui.driveTab) ? app.ui.driveTab : 'heroes';
  app.ui.driveTab = tab;
  const body = tab === 'heroes' ? heroesTab(app) : tab === 'forts' ? fortsTab(app) : landsTab(app);
  const soulWaiting = (app.state.pending || []).some((p) => p.kind === 'soul' && p.land === app.state.playerLand);
  // SOUL の選択待ちでは案内のパネルを出さない（3 枚を押し下げない）。全文は「?」の頭へ
  // 迎えた直後（カットインとトーストが出ている）にも、案内は重ねない
  const guide = soulWaiting || app.ui.driveNew ? null : firstGuide(app, { name: 'drive', face: 'point', text: guideText(app) });
  app.ui.driveGuideInHelp = soulWaiting;
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
  if (el._guide) { lockGuide(el._guide.el); el._guide.start(); }
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
  } else if (tab === 'lands' && lastRankView && lastRankView !== app.ui.driveRankView) {
    // 並べ替えを替えた: 行が上から入り直し、棒が伸びる
    fx.stagger(panel.querySelectorAll('.land-table tbody tr'), { step: 40, from: 'up', distance: 8, ms: 320 });
    if (!fx.reducedMotion()) {
      for (const b of panel.querySelectorAll('.land-table__fpbar')) {
        if (b.animate) b.animate([{ transform: 'translateY(-50%) scaleX(0)' }, { transform: 'translateY(-50%)' }], { duration: 520, easing: 'cubic-bezier(.16, 1, .3, 1)', fill: 'backwards' });
      }
    }
    if (tab === 'heroes') fx.stagger(panel.querySelectorAll('.hero-card'), { step: 80, from: 'up', distance: 18, ms: 520 });
  }
  lastRankView = tab === 'lands' ? app.ui.driveRankView : lastRankView;
  // SOUL: 裏向きの 3 枚が順にめくれる
  const sec = el.querySelector('.soul:not(.is-ready)');
  if (sec) playSoulReveal(sec);
  // 迎えたばかりのヒーロー
  if (app.ui.driveNew) {
    const card = el.querySelector(`.hero-card[data-squad="${app.ui.driveNew}"]`);
    app.ui.driveNew = null;
    if (card) {
      card.classList.add('is-new');
      // 真ん中へ（上のアプリバーと右上のトーストに隠れないように）
      if (card.scrollIntoView) card.scrollIntoView({ block: 'center', behavior: fx.reducedMotion() ? 'auto' : 'smooth' });
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
    lastRankView = null;
    // 案内を一度出したら、離れた時点で見たことにする
    if (el && el._guide) markGuideSeen('drive');
    // 迎えたときのカットインは、別のアプリへ移ったら早送りで閉じる
    for (const c of document.querySelectorAll('.fx-cutin')) c.dispatchEvent(new Event('pointerdown'));
  }
}
