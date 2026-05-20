// ============================================================
// battle/skill-registry.js — スキル metadata (= SPEC-108)
// ============================================================
// 全スキルの metadata を集中管理。 actuation (= 実際の効果適用) は本 SPEC では
// 「通常攻撃」 のみ。 ヒーロー固有スキル (シャーロック・ホームズ 等) は metadata
// だけ用意し implemented: false で UI 上 disabled、 actuation は Phase 2 SPEC-109。

import { getValidAttackTargets } from "./battle-logic.js";

/**
 * @typedef {"single_enemy"|"single_ally"|"single_any"|"self"|"aoe_enemy"} TargetType
 * @typedef {"damage"|"heal"|"buff"} EffectKind
 * @typedef {Object} SkillDef
 * @property {string} id
 * @property {{ja: string, en: string}} name
 * @property {number} cost
 * @property {TargetType} targetType
 * @property {EffectKind} effectKind
 * @property {{ja: string, en: string}} description
 * @property {boolean} implemented
 */

export const BASIC_ATTACK_ID = "basic_attack";

/** @type {Record<string, SkillDef>} */
export const SKILLS = {
  [BASIC_ATTACK_ID]: {
    id: BASIC_ATTACK_ID,
    name: { ja: "通常攻撃", en: "Basic Attack" },
    cost: 0,
    targetType: "single_enemy",
    effectKind: "damage",
    description: {
      ja: "ATK 分のダメージを単体に与える",
      en: "Deal damage equal to ATK to a single target",
    },
    implemented: true,
  },
  sherlock_holmes: {
    id: "sherlock_holmes",
    name: { ja: "シャーロック・ホームズ", en: "Sherlock Holmes" },
    cost: 1,
    targetType: "single_ally",
    effectKind: "buff",
    description: {
      ja: "味方ヒーロー 1 体の ATK を +1 (= Phase 2 未実装)",
      en: "Boost ally ATK by +1 (Phase 2)",
    },
    implemented: false,
  },
  namikiri: {
    id: "namikiri",
    name: { ja: "浪切", en: "Namikiri" },
    cost: 2,
    targetType: "single_enemy",
    effectKind: "damage",
    description: {
      ja: "通常攻撃 +1 ダメージ (= Phase 2 未実装)",
      en: "Basic attack +1 damage (Phase 2)",
    },
    implemented: false,
  },
  ryorai_ryorai: {
    id: "ryorai_ryorai",
    name: { ja: "遼来遼来", en: "Ryorai-Ryorai" },
    cost: 2,
    targetType: "self",
    effectKind: "heal",
    description: {
      ja: "自身を 1 回復 (= Phase 2 未実装)",
      en: "Heal self for 1 (Phase 2)",
    },
    implemented: false,
  },
};

/**
 * @param {string} id
 * @returns {SkillDef | null}
 */
export function getSkillDef(id) {
  return SKILLS[id] || null;
}

/**
 * hero def から使用可能スキル一覧を返す (= 先頭に通常攻撃)
 * @param {object} heroDef - heroes.json の 1 要素
 * @returns {SkillDef[]}
 */
export function getSkillsFor(heroDef) {
  const out = [SKILLS[BASIC_ATTACK_ID]];
  for (const s of (heroDef?.skills || [])) {
    const def = SKILLS[s.id];
    if (def) out.push(def);
  }
  return out;
}

/**
 * skill の有効 target 一覧を返す ({side, slot}[])
 * @param {object} battle
 * @param {"player"|"cpu"} actorSide
 * @param {"front"|"back"|"master"} actorSlot - master は actor になれないが API としては受ける
 * @param {SkillDef} skill
 * @returns {{side: "player"|"cpu", slot: "front"|"back"|"master"}[]}
 */
export function getValidTargetsForSkill(battle, actorSide, actorSlot, skill) {
  if (!skill) return [];
  const opponentSide = actorSide === "player" ? "cpu" : "player";

  switch (skill.targetType) {
    case "single_enemy": {
      // getValidAttackTargets と同じルール: front 優先 → back → master
      const opp = battle[opponentSide];
      const slots = getValidAttackTargets(opp);
      return slots.map((slot) => ({ side: opponentSide, slot }));
    }
    case "single_ally": {
      // 自軍の生存中ユニット + 自軍 master
      const out = [];
      const ally = battle[actorSide];
      for (const slot of ["front", "back"]) {
        const u = ally.field[slot];
        if (u && u.currentHp > 0) out.push({ side: actorSide, slot });
      }
      out.push({ side: actorSide, slot: "master" });
      return out;
    }
    case "single_any": {
      // 両陣営のすべての生存中ユニット + 両 master
      const out = [];
      for (const side of [actorSide, opponentSide]) {
        for (const slot of ["front", "back"]) {
          const u = battle[side].field[slot];
          if (u && u.currentHp > 0) out.push({ side, slot });
        }
        out.push({ side, slot: "master" });
      }
      return out;
    }
    case "self": {
      // actor 自身のみ (= master は actor になれないので front/back のみ)
      if (actorSlot === "master") return [];
      return [{ side: actorSide, slot: actorSlot }];
    }
    case "aoe_enemy": {
      // 敵陣営の全生存ユニット + 敵 master を一括対象 (= Phase 2 で実装)
      return [];
    }
    default:
      return [];
  }
}

/**
 * 指定 target に対する効果プレビューを計算する
 * @param {object} battle
 * @param {"player"|"cpu"} actorSide
 * @param {"front"|"back"|"master"} actorSlot
 * @param {SkillDef} skill
 * @param {{side: string, slot: string}} target
 * @returns {{
 *   targetLabel: string,
 *   hpBefore: number,
 *   hpAfter: number,
 *   damage: number,
 *   isHeal: boolean,
 *   destroysTarget: boolean,
 *   isMasterTarget: boolean,
 * }}
 */
export function computeSkillPreview(battle, actorSide, actorSlot, skill, target) {
  const actor = battle[actorSide].field[actorSlot];
  const targetSide = battle[target.side];
  const isMasterTarget = target.slot === "master";

  let hpBefore;
  let maxHp;
  if (isMasterTarget) {
    hpBefore = targetSide.masterHp;
    maxHp = 10;
  } else {
    const u = targetSide.field[target.slot];
    hpBefore = u ? u.currentHp : 0;
    maxHp = u ? u.maxHp : 0;
  }

  let damage = 0;
  let isHeal = false;

  if (skill.id === BASIC_ATTACK_ID && actor) {
    damage = actor.atk;
  }
  // 他のスキルは未実装。 preview は damage=0 で 「効果なし」 表示する。

  if (skill.effectKind === "heal") {
    isHeal = true;
    // heal の場合 damage を 「回復量」 として扱う (= 簡略化)
  }

  let hpAfter;
  if (isHeal) {
    hpAfter = Math.min(maxHp, hpBefore + damage);
  } else {
    hpAfter = Math.max(0, hpBefore - damage);
  }

  return {
    hpBefore,
    hpAfter,
    damage,
    isHeal,
    destroysTarget: !isHeal && hpAfter === 0,
    isMasterTarget,
  };
}
