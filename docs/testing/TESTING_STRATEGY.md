# Testing Strategy

このテンプレートは **build step なし / vanilla JS** の前提で、 軽量な 3 層テスト戦略を採用する。

## 1. 3 層構造

| 層 | 対象 | ツール | 実行頻度 |
|---|---|---|---|
| 1. Unit (= 純粋関数) | `compute*`, `find*`, `format*`, `pick*` | Node.js + 自作 assert | PR ごと |
| 2. Sim (= シミュレーション) | バランス調整, 経済 loop | Node.js + 自作 runner | バランス調整時 |
| 3. Manual QA | UI / modal / i18n / responsive | ブラウザ手動 | merge 前 |

## 2. Unit テスト

### 2.1 対象関数の条件

- Pure (= side-effect なし)
- DOM / state に依存しない
- 入出力が明確

例:

```js
// 良い候補
export function calcSalary(rank) { return 100 * Math.pow(2, rank); }
export function pickRecipeMaterials(extId, seed) { ... }
export function formatGum(n) { return n.toLocaleString(); }

// 悪い候補 (= state や DOM 依存)
export function renderHeader() { document.getElementById("..."); }
export function tickActiveCraft(idx) { state.activeCraft.progress++; }
```

### 2.2 ファイル配置

```
tools/
  test/
    test-runner.js         ← assert / describe を提供
    unit/
      calc-salary.test.js
      pick-recipe.test.js
      format-gum.test.js
```

### 2.3 自作 test runner (例)

```js
// tools/test/test-runner.js
let _passed = 0, _failed = 0;
const _failures = [];

export function describe(name, fn) {
  console.log(`\n=== ${name} ===`);
  fn();
}

export function test(name, fn) {
  try {
    fn();
    _passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    _failed++;
    _failures.push({ name, error: e });
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
  }
}

export function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(msg || `Expected ${expected}, got ${actual}`);
  }
}
export function assertDeepEqual(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(msg || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function summary() {
  console.log(`\n${_passed} passed, ${_failed} failed`);
  if (_failed > 0) process.exit(1);
}
```

### 2.4 テスト例

```js
// tools/test/unit/calc-salary.test.js
import { describe, test, assertEqual, summary } from "../test-runner.js";
import { calcSalary } from "../../../js/calc.js";

describe("calcSalary", () => {
  test("rank 1 → 100", () => assertEqual(calcSalary(1), 100));
  test("rank 2 → 200", () => assertEqual(calcSalary(2), 200));
  test("rank 5 → 1600", () => assertEqual(calcSalary(5), 1600));
});

summary();
```

実行:
```
node tools/test/unit/calc-salary.test.js
```

## 3. Sim テスト (= 経済 / バランス)

### 3.1 目的

- ゲームの数値バランスを n 回試行で検証
- 全 ヒーロー / 章 / 難易度の組み合わせを網羅
- ヒーロー格差 / 死亡集中率 / 達成率を可視化

### 3.2 ファイル配置

```
tools/
  sim/
    BALANCE_LOOP.md         ← バランス調整方針
    sim-economy.js           ← 経済 loop sim
    sim-combat.js            ← 戦闘 sim
    sim-runner.js            ← 全 sim 起動
    fixtures/
      heroes.json            ← テスト用 ヒーローセット
```

### 3.3 sim-economy.js (例)

```js
import { state } from "./fixtures/state-init.js";
import { tick } from "../../js/main.js";   // ← onTick 相当の純粋関数

const N_RUNS = 100;
const TICKS_PER_RUN = 52 * 5;   // 5 年間

const results = [];
for (let i = 0; i < N_RUNS; i++) {
  const s = JSON.parse(JSON.stringify(state));   // ← deep clone
  for (let t = 0; t < TICKS_PER_RUN; t++) {
    tick(s);
  }
  results.push({
    finalGum: s.gum,
    bankrupt: s.gum < 0,
    yearsLasted: s.year - s.startYear,
  });
}

const bankruptRate = results.filter(r => r.bankrupt).length / N_RUNS;
const avgGum = results.reduce((a, r) => a + r.finalGum, 0) / N_RUNS;

console.log(`Bankrupt rate: ${(bankruptRate * 100).toFixed(1)}%`);
console.log(`Average final GUM: ${avgGum.toFixed(0)}`);
```

### 3.4 収束判定の例

`tools/sim/BALANCE_LOOP.md` に記載:

```
収束条件:
- 全章クリア率: 目標 60% ± 5%
- ヒーロー格差: 最強 / 最弱 ≤ 1.5x
- 各章の死亡集中率: ≥ 40%
- 上記が 3 イテレーション連続で満たされる

ループ:
1. sim を 100 回実行
2. メトリクス計算
3. 範囲外なら data/heroes.json / enemies.json を調整
4. 再 sim
```

## 4. Manual QA

### 4.1 PR ごとに最低限

- [ ] Vercel staging URL で開く
- [ ] PC 表示 (= 1280px+)
- [ ] mobile 表示 (= 375px / Chrome DevTools)
- [ ] Console エラー / 警告がない
- [ ] 該当 Phase の主要動線を一周

### 4.2 マージ前チェック

- [ ] 既存機能の regression がないか (= 別 feature を試す)
- [ ] 言語切替 JP/EN
- [ ] Esc / 背景クリックで modal が閉じるか
- [ ] localStorage を一旦消して初回起動が走るか
- [ ] 連続イベント (= 月次) で freeze しないか

### 4.3 リリース前チェック

`docs/testing/TEST_CASES.md` のチェックリストを通す。

## 5. CI / CD (= 将来)

このテンプレートでは **Vercel preview** を CI 代わりに使う。

将来 GitHub Actions を追加する場合:

```yaml
# .github/workflows/test.yml
name: Test
on: [pull_request]
jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: node tools/test/unit/run-all.js
```

## 6. テストを書く優先順位

1. **計算系の純粋関数** (= calcSalary, pickRecipeMaterials)
2. **State 変換** (= applyDamage, applyHeroChange)
3. **シミュレーション** (= 経済バランス)
4. **UI / DOM** (= テンプレート対象外、 manual QA でカバー)

## 7. テスト書かないものリスト

- DOM 描画 (= renderXxx)
- イベントハンドラ
- modal 開閉
- i18n applyDataI18n
- audio / animation

これらは Manual QA に任せる (= 自動化のコストが高すぎる)。

## 8. テストデータの管理

```
tools/sim/fixtures/
  heroes.json        ← sim 用ヒーロー (= 実 data の subset)
  enemies.json
  state-init.js       ← 初期 state factory
```

実 data を直接使うと sim が遅くなるので、 縮小版を fixture として置く。

## 9. テストの命名

```
test("rank 1 → 100", ...)         ← 入出力ペア
test("空配列で 0 を返す", ...)      ← エッジケース
test("seed 同一なら同結果", ...)    ← 不変条件
```

## 10. レグレッションテストの追加

バグを修正したら、 そのバグの再発を防ぐ unit test を追加:

```js
// SPEC-007 Phase 1F-3: 給与 leak fix
test("salary modal close — pauseFlags returns to 0", () => {
  const s = { pauseFlags: 0 };
  openSalaryReportModal(s);
  closeSalaryReportModal(s);
  assertEqual(s.pauseFlags, 0);
});
```

PR 説明に「regression test 追加済み」 と書く。
