**Added — スプライトアニメ パイプライン (= attach + trigger\*) + 3 体結線 (Day 2 Phase 1D)**

- `js/battle/sprite.js` 新規。 sprite アニメの公開 API:
  - `attachSprite(el, opts)`: `.sprite.is-idle` + side data attr 付与 (= idle ループ開始)
  - `triggerAttackAnim(el, side)`: `is-attack-player` or `is-attack-cpu` を 1 回再生 (= 攻撃方向で keyframe 切替)
  - `triggerHitAnim(el)`: shake + 赤フィルタの `is-hit` を 1 回再生
  - `triggerSummonAnim(el)`: 拡大フェードインの `is-summon` を 1 回再生
  - `triggerDieAnim(el)`: 縮小フェードアウトの `is-die` を再生、 終了 Promise を返す
- `css/battle.css`: `.sprite.is-*` の keyframes 6 種追加 (= idle / attack-player / attack-cpu / hit / summon / die)
  - idle = 1.6s 微小バウンド、 attack = 0.4s 突進、 hit = 0.35s shake + hue-rotate、 summon = 0.5s 拡大フェードイン、 die = 0.45s 縮小フェードアウト
- `js/battle/battle-ui.js`: sprite 結線
  - `renderFieldSlot()` で portrait 要素に attachSprite (= idle 自動開始)
  - 召喚成功 (= `onPlayerSlotClick`) 後に triggerSummonAnim
  - `onAttackTargetClick` を async 化: triggerAttackAnim → 180ms delay → performAttack → triggerHitAnim → 360ms delay → render
  - master 攻撃時は `.battle-side--cpu .battle-side__info` を shake (= triggerHitAnim 流用)
- **実 sprite-sheet PNG は本 SPEC では作らない** (= kickoff 4-3 の `steps()` + horizontal strip は Phase 2 で drop-in 置換。 API 名は kickoff 通りなので本格スプライト着任時に `@keyframes` を入れ替えるだけで切替可能)
- 動作確認: ブラウザでバトルを 1 周回し、 召喚 → idle → 攻撃 → 被弾 → 撃破の各タイミングでアニメが視認できる (= 手動テストは PR の Test plan で reviewer 確認)
