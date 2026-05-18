---
id: SPEC-105
title: スプライトアニメ (= idle/attack/hit/summon/die) + 3 体結線 (Day 2 Phase 1D)
status: Implementing
pr: claude/day2-battle-ui-and-sprites
phase: Phase 1D
kind: Added
---

# SPEC-105 — スプライトアニメ + 3 体結線

## 1. 目的

`MYCRYPTOTCG-KICKOFF.md` 4 章で示された **アニメーションパイプライン** の骨組み
(= attachSprite + trigger* の関数群) と、 SPEC-104 のバトル画面 UI への結線を
実装する。 視覚的に「召喚 / 攻撃 / 被弾」 がプレイヤーに伝わる状態にする。

## 2. 実装方針: sprite-sheet ではなく CSS transform / filter

kickoff 4-3 では CSS `steps()` + horizontal strip PNG sprite sheet を採用する
想定だった。 ただし Phase 1D の目的は **「パイプラインが動くこと」** であり、
画質よりも 「API が trigger\* で呼べる + 視覚的に攻撃 / 被弾が分かる」 が DoD。

そこで Phase 1D では:

- **既存の MCH 公式ポートレート** (= `data/cards/heroes.json` の `portraitUrl`)
  を CSS `background-image` として表示
- 動きは **CSS `transform` / `filter` の keyframes** で表現 (= 振動 / 拡縮 / 色変化)
- 「sprite-sheet PNG + `steps()`」 は **Phase 2 で本格スプライト制作と一緒に
  drop-in 置換** する前提で、 API 名 (`attachSprite` / `triggerAttackAnim` 等)
  だけ kickoff の設計と一致させる

この方針で、 placeholder PNG をリポにコミットせずに済み (= バイナリ管理を回避)、
かつ Phase 2 で `assets/sprites/heroes/<id>/<action>.png` を追加して
`@keyframes` を差し替えるだけで本格スプライトに切替可能。

## 3. スコープ

### In Scope

- `js/battle/sprite.js` 新規:
  - `attachSprite(el, opts)`: 要素に `.sprite.is-idle` + side data attr 付与
  - `triggerAttackAnim(el, side)`: `is-attack-player` or `is-attack-cpu` を 1 回再生
  - `triggerHitAnim(el)`: `is-hit` を 1 回再生
  - `triggerSummonAnim(el)`: `is-summon` を 1 回再生
  - `triggerDieAnim(el)`: `is-die` を再生し、 終了 Promise を返す
- `css/battle.css` 追加: `.sprite.is-*` の keyframes 5 種 (= idle / attack-player / attack-cpu / hit / summon / die)
- `js/battle/battle-ui.js` 改修:
  - `renderFieldSlot()` で portrait 要素に `attachSprite` を呼ぶ
  - `onPlayerSlotClick()` の召喚成功時に `triggerSummonAnim`
  - `onAttackTargetClick()` を async 化し、 `triggerAttackAnim` → ディレイ → `performAttack` → `triggerHitAnim` → ディレイ → render の順
  - Master 攻撃時は CPU 側の `.battle-side__info` を shake (= triggerHitAnim を流用)
  - 被弾で die した場合は `triggerDieAnim` → 終了後に renderBattle (= 自然な消失)

### Out of Scope

- 実際の sprite-sheet PNG 制作 (= Phase 2、 Aseprite または AI 補助)
- ヒーロー個別の固有アニメ (= Phase 2、 全ヒーロー共通の汎用アニメで足りる)
- スキル発動演出 (= スキル自体が Phase 2)
- 効果音 / BGM (= Phase 2 以降)
- パーティクル / confetti / float 数値 (= 既存 `js/effects.js` を流用するが本 SPEC では結線しない、 SPEC-107 でダメージ数値浮上を実装)

## 4. CSS keyframes 設計

```css
.sprite {
  transform-origin: center;
  /* base, applied to .field-slot__portrait / .hand-card__portrait */
}

/* idle: 微小バウンド (= 「生きている」 感) */
.sprite.is-idle {
  animation: sprite-idle 1.6s ease-in-out infinite;
}
@keyframes sprite-idle {
  0%, 100% { transform: translateY(0); }
  50%      { transform: translateY(-2px); }
}

/* attack-player: 上に向かって突進 (= player の field は下、 cpu は上) */
.sprite.is-attack-player {
  animation: sprite-attack-player 0.4s ease-out;
}
@keyframes sprite-attack-player {
  0%   { transform: translateY(0) scale(1); }
  40%  { transform: translateY(-10px) scale(1.06); }
  100% { transform: translateY(0) scale(1); }
}

/* attack-cpu: 下方向 */
.sprite.is-attack-cpu {
  animation: sprite-attack-cpu 0.4s ease-out;
}
@keyframes sprite-attack-cpu {
  0%   { transform: translateY(0) scale(1); }
  40%  { transform: translateY(10px) scale(1.06); }
  100% { transform: translateY(0) scale(1); }
}

/* hit: shake + 赤フィルタ */
.sprite.is-hit {
  animation: sprite-hit 0.35s ease-in-out;
}
@keyframes sprite-hit {
  0%   { transform: translateX(0); filter: none; }
  20%  { transform: translateX(-4px); filter: brightness(1.6) hue-rotate(320deg) saturate(2); }
  50%  { transform: translateX(4px); filter: brightness(1.6) hue-rotate(320deg) saturate(2); }
  80%  { transform: translateX(-2px); filter: brightness(1.3) hue-rotate(320deg); }
  100% { transform: translateX(0); filter: none; }
}

/* summon: 拡大しながらフェードイン */
.sprite.is-summon {
  animation: sprite-summon 0.5s ease-out;
}
@keyframes sprite-summon {
  0%   { transform: scale(0.4) rotate(-12deg); opacity: 0; }
  60%  { transform: scale(1.18) rotate(0); opacity: 1; }
  100% { transform: scale(1); }
}

/* die: 縮小しながらフェードアウト */
.sprite.is-die {
  animation: sprite-die 0.45s ease-in forwards;
}
@keyframes sprite-die {
  0%   { transform: scale(1); opacity: 1; filter: none; }
  100% { transform: scale(0.55); opacity: 0; filter: grayscale(1) brightness(0.5); }
}
```

## 5. JS シグネチャ

```js
// js/battle/sprite.js

export function attachSprite(el, opts): void;
// opts = { side: "player" | "cpu" } を data-* に保持 (= 攻撃方向の決定に使う)

export function triggerAttackAnim(el, side): void;
// side === "cpu" なら is-attack-cpu、 それ以外は is-attack-player

export function triggerHitAnim(el): void;
export function triggerSummonAnim(el): void;
export function triggerDieAnim(el): Promise<void>;
```

各 trigger\* は **既存の動的アニメ class を一旦 remove → reflow → add → animationend で remove** のパターン (= 連続発火に対応)。

## 6. battle-ui.js 結線

### 6-1. renderFieldSlot

field-slot に portrait を生成する箇所で、 portrait 要素に `attachSprite` を呼ぶ:

```js
const portraitEl = el.querySelector(".field-slot__portrait");
attachSprite(portraitEl, { side: opponentSide /* "player" or "cpu" */ });
```

### 6-2. onPlayerSlotClick (= 召喚成功時)

```js
summonHero(battle.player, cardId, cardDb, row);
resetUiState();
renderBattle();
const newPortrait = $(`#playerField${cap(row)} .field-slot__portrait`);
if (newPortrait) triggerSummonAnim(newPortrait);
```

### 6-3. onAttackTargetClick (= async 化)

```js
async function onAttackTargetClick(targetSlot) {
  const attackerEl = $(`#playerField${cap(_selectedAttackerSlot)} .field-slot__portrait`);
  const targetEl = targetSlot === "master"
    ? $(".battle-side--cpu .battle-side__info")   // master 被弾は info を shake
    : $(`#cpuField${cap(targetSlot)} .field-slot__portrait`);

  triggerAttackAnim(attackerEl, "player");
  await delay(180);  // attack 中盤で hit へ移行

  try { performAttack(battle.player, battle.cpu, _selectedAttackerSlot, targetSlot); }
  catch (e) { ... }

  if (targetEl) triggerHitAnim(targetEl);
  await delay(360);  // hit 終了まで

  // 撃破された場合は die アニメを古い slot に流したいが、 すでに field[slot] = null
  // なので renderBattle で空状態に切り替わる。 die アニメは Phase 2 でユニット撃破の
  // 視覚的余韻として組み込む (= 現状は静かに消える)

  resetUiState();
  const winner = checkVictory(battle);
  if (winner) { finishBattle(winner); return; }
  renderBattle();
}
```

## 7. テスト計画

### 7-1. ブラウザ手動テスト

- [ ] 召喚直後の portrait が `sprite-summon` で拡大フェードイン
- [ ] 召喚後 idle 状態で portrait が微かに上下バウンド
- [ ] 召喚酔いは `field-slot--sick` の半透明 + filter で視認できる
- [ ] 攻撃時、 攻撃側 portrait が突進 → 0.18 秒後に被弾側が shake + 赤
- [ ] master を攻撃すると CPU 側 `.battle-side__info` が shake
- [ ] ユニット撃破時、 該当 slot が次の render で empty に切り替わる
- [ ] 連続攻撃 (= 別ユニット使用) で is-attack class が正しく付け外しされる
- [ ] JP / EN 切替で portrait アニメが破綻しない

### 7-2. console / Node 検証

- [ ] `attachSprite(el)` で `el.classList.contains("sprite")` and `el.classList.contains("is-idle")` が true
- [ ] `triggerAttackAnim(el, "cpu")` で `is-attack-cpu` が一時的に付く → animationend で remove
- [ ] `triggerDieAnim(el)` の Promise が animationend で resolve

(Node 側 DOM はないため、 ブラウザ手動が主)

## 8. PR 構成

- 同 PR (= `claude/day2-battle-ui-and-sprites`) で SPEC-104 と同居
- コミット 1: SPEC-105 docs + changelog fragment
- コミット 2: css/battle.css に sprite keyframes 追記
- コミット 3: js/battle/sprite.js 新規
- コミット 4: js/battle/battle-ui.js 改修 (= attachSprite / trigger\* 結線、 onAttack を async に)
- コミット 5: SPEC-INDEX / CHANGELOG 再生成

## 9. 関連 SPEC

- SPEC-100: 3 日計画 (= 上位)
- SPEC-104: Phase 1C (= 前段、 本 SPEC は SPEC-104 の field-slot / portrait DOM に乗る)
- SPEC-106: Phase 1E (= 次段、 CPU AI が攻撃するようになった時に本 SPEC の trigger\* を CPU 側でも使う)
- Phase 2 (= 別途): 実 sprite-sheet PNG 制作 + Aseprite パイプライン定着 (= SPEC-014)
