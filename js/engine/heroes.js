// ヒーロー（MCH の max_level_stats → 6 パラメーター・部隊の種類・スキル種別・口調）。
// DOM に触れない純粋関数だけ。scripts/build-data.mjs もここを import して data/heroes.json を作る。
// 契約: docs/specs/SPEC-110-engine-contract.md §1.4・§3 heroes.js。式は docs/specs/SPEC-109-mycryptowars-mvp.md §5.1・§5.2。

/** パラメーターのキー（装備の加算もこの 6 つ） */
export const PARAM_KEYS = ["act", "lead", "str", "int", "gov", "pol"];

/** 大分類 → 小分類 */
export const SUBS_BY_MAIN = {
  front: ["vanguard", "striker", "guard", "commander", "scout"],
  mid: ["gunner", "support"],
  back: ["sniper", "caster", "healer"],
};

/** 小分類 → 大分類 */
export const MAIN_OF_SUB = Object.fromEntries(
  Object.entries(SUBS_BY_MAIN).flatMap(([main, subs]) => subs.map((s) => [s, main]))
);

export const TONES = ["bushi", "noble", "scholar", "rogue", "plain"];

// 0.55 × 100 = 55.00000000000001 のような浮動小数のごみで切り上げが 1 つ増えないよう、
// 小数第 6 位で丸めてから切り上げる。
const ceil = (v) => Math.ceil(Math.round(v * 1e6) / 1e6);

/**
 * MCH の max_level_stats から 6 パラメーターを出す（spec §5.1。小数点以下は切り上げ）。
 * @param {{hp:number, phy:number, int:number, agi:number}} stats
 * @returns {{act:number, lead:number, str:number, int:number, gov:number, pol:number}}
 */
export function toParams(stats) {
  const { hp, phy, int, agi } = stats;
  return {
    act: ceil(3 + agi / 15),
    lead: ceil((hp / 4 + phy + int + agi) / 5),
    str: ceil((phy + int) / 14),
    int: ceil(int * 0.55),
    gov: ceil((int + agi) / 6),
    pol: ceil((phy + agi) / 6),
  };
}

/**
 * 型（PHY / INT / AGI のうち最大）。同点は PHY → INT → AGI の順で先のものを採る。
 * @param {{phy:number, int:number, agi:number}} stats
 * @returns {"PHY"|"INT"|"AGI"}
 */
export function statType(stats) {
  const m = Math.max(stats.phy, stats.int, stats.agi);
  if (stats.phy === m) return "PHY";
  if (stats.int === m) return "INT";
  return "AGI";
}

/**
 * 部隊の種類（spec §5.2）。
 *
 * 型：PHY 型 → front、AGI 型 → mid、INT 型 → back（同点は PHY → INT → AGI）。
 *
 * 小分類の判定（上から順に最初に当たったもの。しきい値は実データ 201 体で
 * 10 種それぞれが 5 体以上になるように決めた）：
 *
 * front（PHY 型）
 *   1. scout     … AGI / PHY ≥ 0.95（AGI が PHY とほぼ並ぶ）
 *   2. guard     … HP / PHY ≥ 3.6（HP 突出）
 *   3. striker   … PHY / max(INT, AGI) ≥ 1.5（PHY 突出）
 *   4. commander … スキルが buff
 *   5. vanguard  … AGI / PHY ≥ 0.7（AGI 高め）
 *   6. 残り      … HP / PHY ≥ 2.8 なら guard、それ以外は striker
 * mid（AGI 型）
 *   support … スキルが heal か debuff。それ以外は gunner
 * back（INT 型）
 *   healer … スキルが heal
 *   caster … スキルが damage
 *   sniper … それ以外で AGI / INT ≥ 0.6（AGI 高め）。それ以外は caster
 *
 * @param {{hp:number, phy:number, int:number, agi:number}} stats
 * @param {"damage"|"heal"|"buff"|"debuff"} skillKind
 * @param {string[]} [attributes] いまは使わない（将来の補正用に受けるだけ）
 * @returns {{main:"front"|"mid"|"back", sub:string}}
 */
export function classify(stats, skillKind, attributes = []) {
  void attributes;
  const type = statType(stats);
  const { hp, phy, int, agi } = stats;
  if (type === "PHY") {
    let sub;
    if (agi / phy >= 0.95) sub = "scout";
    else if (hp / phy >= 3.6) sub = "guard";
    else if (phy / Math.max(int, agi) >= 1.5) sub = "striker";
    else if (skillKind === "buff") sub = "commander";
    else if (agi / phy >= 0.7) sub = "vanguard";
    else sub = hp / phy >= 2.8 ? "guard" : "striker";
    return { main: "front", sub };
  }
  if (type === "AGI") {
    const sub = skillKind === "heal" || skillKind === "debuff" ? "support" : "gunner";
    return { main: "mid", sub };
  }
  let sub;
  if (skillKind === "heal") sub = "healer";
  else if (skillKind === "damage") sub = "caster";
  else sub = agi / int >= 0.6 ? "sniper" : "caster";
  return { main: "back", sub };
}

/**
 * MCH のパッシブスキルの説明文（日本語）から種類を導く。
 * 「ダメージ」→ damage、「回復」→ heal、「ダウン」「減少」→ debuff、「アップ」「増加」→ buff。
 * 複合しているときの優先は damage > heal > debuff > buff。
 * どれにも当たらない文（シールド・バリア・デコイ・恐怖 など 8 体）は、
 * 恐怖・呪い・封印 → debuff、それ以外 → buff に倒す。
 * @param {string} passiveTextJa
 * @returns {"damage"|"heal"|"buff"|"debuff"}
 */
export function skillKindOf(passiveTextJa) {
  const t = String(passiveTextJa || "");
  if (t.includes("ダメージ")) return "damage";
  if (t.includes("回復")) return "heal";
  if (/ダウン|減少/.test(t)) return "debuff";
  if (/アップ|増加/.test(t)) return "buff";
  if (/恐怖|呪い|封印/.test(t)) return "debuff";
  return "buff";
}

/**
 * 口調を決める属性の語彙（MCH の attributes の日本語名）。
 * 判定は「各口調に当たる属性の数」を数え、いちばん多い口調。同数なら
 * rogue → scholar → noble → bushi の順で先のものを採る（狭い語彙を先に）。
 * どれにも当たらなければ plain。
 * 実データ 201 体での分布：scholar 61 / bushi 57 / noble 35 / rogue 24 / plain 24。
 */
export const TONE_WORDS = {
  rogue: ["海", "隠密", "黒ひげ海賊団", "ウェスタン", "旅"],
  scholar: ["文系学問", "理系学問", "美術", "音楽", "機械", "宇宙", "童話", "芸能"],
  noble: ["指導者", "政治", "天下人", "世界三大美女"],
  bushi: [
    "戦国", "三国志", "蜀", "魏", "呉", "長柄武器", "平安鎌倉", "幕末", "新撰組", "江戸",
    "戦術", "円卓の騎士", "本能寺の変", "桃園の誓い", "四面楚歌",
  ],
};
const TONE_ORDER = ["rogue", "scholar", "noble", "bushi"];

/**
 * 属性（と勢力）から口調を決める。勢力は 5 つとも口調と結び付かないので、いまは属性だけで決める。
 * @param {string[]} attributes 属性の日本語名
 * @param {number} [faction] MCH の勢力 id（1 朱雀 / 2 青龍 / 3 玄武 / 4 黄竜 / 5 白虎。未使用）
 * @returns {"bushi"|"noble"|"scholar"|"rogue"|"plain"}
 */
export function toneOf(attributes, faction) {
  void faction;
  const score = { rogue: 0, scholar: 0, noble: 0, bushi: 0 };
  for (const a of attributes || []) {
    for (const t of TONE_ORDER) if (TONE_WORDS[t].includes(a)) score[t]++;
  }
  let best = "plain";
  let bestV = 0;
  for (const t of TONE_ORDER) {
    if (score[t] > bestV) {
      best = t;
      bestV = score[t];
    }
  }
  return best;
}

function equipOf(squad, db) {
  if (!squad || squad.equip == null || !db || !db.extensions) return null;
  return db.extensions[squad.equip] || null;
}

/**
 * 装備の加算込みのパラメーター。
 * @param {object} hero data/heroes.json の 1 体
 * @param {object|null} squad state の Squad（equip を見る）
 * @param {object} db
 */
export function effectiveParams(hero, squad, db) {
  const p = { ...hero.params };
  const ext = equipOf(squad, db);
  if (ext && ext.effect) {
    for (const k of PARAM_KEYS) if (typeof ext.effect[k] === "number") p[k] += ext.effect[k];
  }
  return p;
}

/**
 * 率いられる兵の上限。lead × 10 + 装備の troopCap。lead は装備の加算込み。
 */
export function troopCap(hero, squad, db) {
  const ext = equipOf(squad, db);
  const extra = ext && ext.effect && typeof ext.effect.troopCap === "number" ? ext.effect.troopCap : 0;
  return effectiveParams(hero, squad, db).lead * 10 + extra;
}

/**
 * 回復で戻せる上限（定員）。SPEC-113 §2.1。
 * 定員（squad.mustered）は、その部隊が徴兵などで集めた兵の数。夜の回復・休息・回復スキル・敗走からの集め直しは
 * 定員までしか戻せない（戦いで減った兵を戻すだけ）。定員を超えて兵を増やせるのは徴兵だけ。
 * mustered が無い（古いセーブ・手書きの state）ときは今の兵の数を定員とみなす。
 */
export function musterCap(hero, squad, db) {
  return Math.min(troopCap(hero, squad, db), musteredOf(squad));
}

/**
 * 部隊の定員（squad.mustered）。無ければ今の兵の数。上限（troopCap）では切らない（切るのは musterCap）。
 */
export function musteredOf(squad) {
  const m = typeof squad.mustered === "number" && Number.isFinite(squad.mustered) ? squad.mustered : squad.troops || 0;
  return Math.max(0, m);
}

/**
 * 視界。2。scout は 3。装備の vision を足す。
 */
export function visionOf(hero, squad, db) {
  const ext = equipOf(squad, db);
  const extra = ext && ext.effect && typeof ext.effect.vision === "number" ? ext.effect.vision : 0;
  return (hero.cls && hero.cls.sub === "scout" ? 3 : 2) + extra;
}

/**
 * 射程。front 1 / mid 2 / back 3。caster・support・healer は 2。
 */
export function rangeOf(hero) {
  const sub = hero.cls && hero.cls.sub;
  if (sub === "caster" || sub === "support" || sub === "healer") return 2;
  const main = hero.cls && hero.cls.main;
  if (main === "front") return 1;
  if (main === "back") return 3;
  return 2;
}

const NEUTRAL = { atk: 1, def: 1, actDelta: 0, skillMult: 1, healAdj: 0 };
const SUB_MODS = {
  vanguard: { ...NEUTRAL, actDelta: 1 },
  striker: { ...NEUTRAL, atk: 1.2, actDelta: -1 },
  guard: { ...NEUTRAL, def: 1.3, actDelta: -1 },
  commander: { ...NEUTRAL }, // 隣接する味方の攻防 +10% は battle.js が見る
  scout: { ...NEUTRAL, atk: 0.8, def: 0.8, actDelta: 1 },
  gunner: { ...NEUTRAL },
  support: { ...NEUTRAL, actDelta: -1, healAdj: 0.05 },
  sniper: { ...NEUTRAL, atk: 0.9 },
  caster: { ...NEUTRAL, skillMult: 1.5, actDelta: -1 },
  healer: { ...NEUTRAL, atk: 0.7, def: 0.7, healAdj: 0.1 },
};

/**
 * 小分類の係数（spec §5.2）。healAdj は隣接する味方の兵を毎ターン回復する割合。
 * @param {string} sub
 * @returns {{atk:number, def:number, actDelta:number, skillMult:number, healAdj:number}}
 */
export function subMods(sub) {
  return { ...(SUB_MODS[sub] || NEUTRAL) };
}

function heroListOf(db) {
  if (db.heroList) return db.heroList;
  return Object.values(db.heroes || {});
}

/**
 * 開始時の 3 体。Common〜Uncommon から front / mid / back を 1 体ずつ。
 * usedIds にあるものは選ばず、選んだものは usedIds に足す（他ランドと重ならないように、
 * 呼ぶ側は同じ Set を使い回す）。足りないときは Rare まで、それでも無ければ全レアリティに広げる。
 * @param {() => number} rng
 * @param {object} db
 * @param {number} landIndex ランドの並び順（いまは使わない。順番は rng で決まる）
 * @param {Set<number>} [usedIds]
 * @returns {number[]} [front, mid, back] の heroId
 */
export function starterHeroes(rng, db, landIndex, usedIds = new Set()) {
  void landIndex;
  const list = heroListOf(db);
  const out = [];
  for (const role of ["front", "mid", "back"]) {
    let pool = [];
    for (const maxRarity of [2, 3, 5]) {
      pool = list.filter((h) => h.rarity <= maxRarity && h.cls.main === role && !usedIds.has(h.id));
      if (pool.length) break;
    }
    if (!pool.length) break;
    const hero = pool[Math.floor(rng() * pool.length)];
    usedIds.add(hero.id);
    out.push(hero.id);
  }
  return out;
}
