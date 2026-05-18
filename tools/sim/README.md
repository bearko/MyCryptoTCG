# tools/sim/

ゲームバランス調整 / 経済 sim を置くディレクトリ。

## ファイル構成

```
tools/sim/
  README.md           ← このファイル
  BALANCE_LOOP.md     ← 収束条件と loop 仕様
  sim-economy.js      ← 経済 loop sim
  sim-combat.js       ← 戦闘 sim
  sim-runner.js       ← 全 sim 起動
  fixtures/
    heroes.json
    state-init.js
```

## 使い方

```bash
# 単発
node tools/sim/sim-economy.js

# 全部回す
node tools/sim/sim-runner.js
```

## バランス調整 loop

詳細は `BALANCE_LOOP.md` を参照。 概要:

```
1. sim を 100 回実行
2. メトリクスを計算 (= bankrupt rate, hero gap, death concentration)
3. 範囲外なら data/heroes.json / enemies.json を調整
4. 再 sim
5. 3 イテレーション連続で収束したら確定
```

## Claude Code との連携

`/loop` skill でバランス調整 loop を回せる:

```
/loop バランス調整ループを開始してください。
仕様は tools/sim/BALANCE_LOOP.md。
収束するまで継続してください。
最大予算は 4-5 時間。
```

## ファイル設計

`js/main.js` の `onTick` を Node.js から呼べるように、 純粋関数として分離する。

```js
// js/tick.js (= main.js から分離)
export function tickPure(state) {
  // state を受け取って state を返す (= 副作用なし)
}
```

```js
// tools/sim/sim-economy.js
import { tickPure } from "../../js/tick.js";
// ...
```
