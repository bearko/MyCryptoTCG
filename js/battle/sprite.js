// ============================================================
// battle/sprite.js — スプライトアニメ pipeline (= Phase 1D SPEC-105)
// ============================================================
// kickoff 4-3 で示された attachSprite / triggerAttackAnim / triggerHitAnim を、
// CSS transform/filter ベースで実装。 Phase 2 で sprite-sheet PNG が用意され
// たら @keyframes を入れ替えるだけで drop-in 置換可能。

const ATTACK_PLAYER = "is-attack-player";
const ATTACK_CPU    = "is-attack-cpu";
const HIT_CLASS     = "is-hit";
const SUMMON_CLASS  = "is-summon";
const DIE_CLASS     = "is-die";

/**
 * 要素を sprite として初期化 (= idle ループ開始)
 * @param {HTMLElement|null} el
 * @param {{side?: "player"|"cpu"}} [opts]
 */
export function attachSprite(el, opts) {
  if (!el) return;
  el.classList.add("sprite", "is-idle");
  if (opts && opts.side) {
    el.dataset.spriteSide = opts.side;
  }
}

/**
 * 攻撃アニメを 1 回再生
 * @param {HTMLElement|null} el
 * @param {"player"|"cpu"} side - 攻撃側 (= player なら上方向、 cpu なら下方向)
 */
export function triggerAttackAnim(el, side) {
  if (!el) return;
  const cls = side === "cpu" ? ATTACK_CPU : ATTACK_PLAYER;
  restartAnimation(el, cls);
}

/**
 * 被弾アニメを 1 回再生
 * @param {HTMLElement|null} el
 */
export function triggerHitAnim(el) {
  if (!el) return;
  restartAnimation(el, HIT_CLASS);
}

/**
 * 召喚アニメを 1 回再生
 * @param {HTMLElement|null} el
 */
export function triggerSummonAnim(el) {
  if (!el) return;
  restartAnimation(el, SUMMON_CLASS);
}

/**
 * 撃破アニメを再生し、 終了後に resolve
 * (= forwards で 0 を維持するため、 呼び出し側で element を消すまで非表示状態が保たれる)
 * @param {HTMLElement|null} el
 * @returns {Promise<void>}
 */
export function triggerDieAnim(el) {
  if (!el) return Promise.resolve();
  return new Promise((resolve) => {
    const onEnd = () => {
      el.removeEventListener("animationend", onEnd);
      resolve();
    };
    el.addEventListener("animationend", onEnd, { once: true });
    el.classList.add(DIE_CLASS);
  });
}

// ============================================================
// internal
// ============================================================

/**
 * 既存のアニメ class を一度外し、 リフローを挟んで再 add (= 連続発火に対応)
 * animationend で自動的に外す (= 一回限り)
 * @param {HTMLElement} el
 * @param {string} cls
 */
function restartAnimation(el, cls) {
  el.classList.remove(cls);
  // force reflow (= cls の add を確実に新しいアニメとして扱わせる)
  void el.offsetWidth;
  el.classList.add(cls);
  const onEnd = () => {
    el.classList.remove(cls);
    el.removeEventListener("animationend", onEnd);
  };
  el.addEventListener("animationend", onEnd, { once: true });
}
