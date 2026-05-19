**Added — CPU AI ルールベース (= 弱め貪欲) + アニメ結線 (Day 3 Phase 1E)**

- `js/battle/cpu-ai.js` 新規。 `chooseCpuAction(battle)` (= 純粋関数) で次の 1 アクションを `{type, ...}` で返す
  - 召喚: 召喚可能なカードのうち **最高コスト** を選ぶ (= ストーンを使い切る単純貪欲)
  - 攻撃: front → back の順で行動可能ユニットを 1 体選び、 `getValidAttackTargets` 先頭を狙う
  - それ以外: `{type: "end"}`
- `js/battle/cpu-turn.js` 改修。 旧 auto-pass を捨て `chooseCpuAction` ループで実行
  - 召喚: `summonHero` → render → `triggerSummonAnim` → 700ms delay
  - 攻撃: `triggerAttackAnim(side:"cpu")` → 180ms → `performAttack` → `triggerHitAnim` → 360ms → render
  - 各アクション後に `checkVictory` で player 撃破を検知し finishBattle で early-exit
  - end action 後に `endTurn(battle)` で player に turn を戻し、 player の startTurn を呼ぶ
- 既存の startTurn / endTurn / delay は同居のため重複定義を解消 (= delay は cpu-turn.js 内 1 箇所に集約)
- 「弱め」 定義: 最善手なし、 評価関数なし、 単純貪欲。 難易度オプションは Phase 2 以降の議論
- スキル発動 / 撤退 / レベルアップ は本 SPEC のスコープ外 (= Phase 2)
