# Balance Loop — バランス調整自動 loop

## 1. 目的

- ゲームの数値バランスを自動 sim で検証
- 収束条件を満たすまで data/*.json を調整しながら繰り返す
- 最大予算 (= 4-5 時間) を超えたら一旦停止

## 2. 収束条件 (例)

このテンプレートはゲーム種別によって調整するべきだが、 例として:

- 全章 / 全ステージのクリア率: 目標 60% ± 5%
- ヒーロー格差 (= 最強 / 最弱 power 比): ≤ 1.5x
- 各章の死亡集中率 (= 全敗北の中で各章が占める割合): ≥ 40%
- 上記 3 つが **3 イテレーション連続** で満たされたら収束と判定

## 3. ループ仕様

```
while (not converged) {
  1. sim を N=100 回実行 (= 各回 ticks=260 等)
  2. メトリクス計算
  3. 収束判定
     - 収束 → 連続カウンタ +1
     - 失敗 → 連続カウンタリセット
     - 連続カウンタ >= 3 → exit
  4. 範囲外メトリクスがあれば data 調整
     - 例: bankrupt rate 高すぎ → 月給を下げる / 報酬を上げる
     - 例: ヒーロー格差大 → 最強の power を下げる / 最弱を上げる
  5. ループ再開
}
```

## 4. メトリクス算出 (例)

```js
const N = 100;
const results = [];
for (let i = 0; i < N; i++) {
  const s = makeInitialState();
  for (let t = 0; t < TICKS_PER_RUN; t++) tickPure(s);
  results.push({
    bankrupt: s.gum < 0,
    yearsLasted: s.year - s.startYear,
    finalGum: s.gum,
    heroPowerStats: computeHeroPowerStats(s),
  });
}

const bankruptRate = results.filter(r => r.bankrupt).length / N;
const avgYears = results.reduce((a, r) => a + r.yearsLasted, 0) / N;
const heroGap = computeMaxMinRatio(results);
```

## 5. 自動調整ロジック

```js
if (bankruptRate > 0.45) {
  // 報酬を 5% 増やす
  for (const it of itemData) it.reward *= 1.05;
}
if (heroGap > 1.5) {
  // 最強ヒーローの power を 5% 下げる
  const top = heroData.sort((a, b) => b.power - a.power)[0];
  top.power = Math.round(top.power * 0.95);
}
```

## 6. 出力

```
Iteration 1:
  bankrupt rate: 52% (target 60% ±5%) — FAIL
  hero gap: 1.78x (target ≤1.5x) — FAIL
  death concentration: 35% (target ≥40%) — FAIL
  Adjusted: heroes.json (top -5%), enemies.json (ch3 +10% hp)
  Continue.

Iteration 12:
  bankrupt rate: 58% — OK
  hero gap: 1.42x — OK
  death concentration: 42% — OK
  Convergence streak: 1/3

Iteration 13:
  ... 2/3

Iteration 14:
  ... 3/3 → CONVERGED
  Total iterations: 14
  Total runs: 1400
  Final adjustments: ...
```

## 7. データのスナップショット

各 iteration の data を保存:

```
tools/sim/snapshots/
  iter-001/
    heroes.json
    enemies.json
    metrics.json
  iter-002/
  ...
```

## 8. 早期停止条件

- 予算超過: `process.uptime() > 4 * 60 * 60` (= 4 時間)
- 発散検出: 3 イテレーション連続で収束から遠ざかった
- ユーザー Ctrl+C

## 9. テンプレートでの状態

このテンプレートには **scaffolding のみ** があり、 具体的な sim ロジックはプロジェクトごとに実装する。 SPEC を書くのが推奨:

```
specs/SPEC-NNN-balance-sim.md
```

## 10. Claude Code 連携

`/loop` skill で自動回しを依頼できる:

```
/loop バランス調整ループを開始してください。
仕様は tools/sim/BALANCE_LOOP.md。
収束するまで継続してください。
次回のイテレーション間隔は ScheduleWakeup で 60 秒程度に。
```

実装が無い段階で呼ぶと「実装が必要」 と返ってくる。 まず SPEC を書く。
