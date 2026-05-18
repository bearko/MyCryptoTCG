# Pattern 08 — 開発規約 (命名・コミット・PR)

## 1. ファイル命名

### 1.1 JS モジュール

| パターン | 用途 | 例 |
|---|---|---|
| `<feature>.js` | 単機能 | `craft.js`, `quest.js` |
| `<feature>-<aspect>.js` | 機能の側面 | `ranking-client.js`, `data-loader.js` |
| `<domain>-utils.js` | 共通ユーティリティ | `array-utils.js`, `string-utils.js` |

すべて kebab-case。 PascalCase / camelCase は使わない。

### 1.2 CSS

```
css/
  base.css        ← reset + 変数 + body
  layout.css      ← grid, header, view 切替
  components.css  ← button, card, modal
  effects.css     ← @keyframes
  responsive.css  ← @media (mobile / tablet / pc)
```

### 1.3 データ JSON

```
data/
  i18n/
    ui.json
    heroes-en.json
    enemies-en.json
  heroes.json
  extensions.json
  shop-items.json
```

複数形 + kebab-case。 `data/i18n/` にある言語ファイルは `<domain>-<lang>.json`。

## 2. 関数命名

### 2.1 動詞 prefix

| Prefix | 役割 | 例 |
|---|---|---|
| `trigger*` | イベント発火 | `triggerCraftCompletion()`, `triggerConfetti()` |
| `open*` / `close*` | Modal | `openSalaryModal()`, `closeSalaryModal()` |
| `render*` | DOM 描画 (= 副作用) | `renderHeader()`, `renderShop()` |
| `pick*` | 選択 (= 抽選) | `pickRandomHero()`, `pickRecipeMaterials()` |
| `apply*` | state 変更 | `applyDamage()`, `applyHeroChange()` |
| `find*` | 探索 (= return 値) | `findEmptyCraftSlot()`, `findHeroById()` |
| `get*` / `set*` | プロパティ | `getActiveCraft(idx)`, `setActiveCraft(idx, ac)` |
| `tick*` | onTick 内処理 | `tickActiveCraft()`, `tickActiveQuest()` |
| `is*` / `has*` | 真偽値 return | `isHeroBusy(h)`, `hasMaterial(id, qty)` |
| `compute*` / `calc*` | 計算 (= pure) | `computeHeroPower(h)`, `calcSalary(rank)` |
| `format*` | 表示文字列化 | `formatTimestamp(ts)`, `formatGum(n)` |

### 2.2 boolean 命名

```js
const isActive   = state.tickCount > 0;
const hasItems   = state.warehouse.length > 0;
const canCraft   = state.gum >= cost;
const shouldPause = state.pauseFlags > 0;
```

NG: `active`, `items`, `craft`, `pause` (= 名詞だけ)

### 2.3 ヘルパーは `_` prefix

```js
function _decodeDefault() { ... }       // module-private
function _ensureSheet() { ... }         // GAS-private
const _maiNextAction = null;            // module-internal state
```

ESM では真の private がないので、 慣習として `_` を付ける。

## 3. 変数命名

### 3.1 `state.*`

```js
state.tickCount            // count 系は <singular>Count
state.weekProgress         // progress 系は <singular>Progress  
state.year, state.month, state.week   // 単純名
state.activeCraft          // active<Feature> = 進行中アイテム
state.pendingSalaryReport  // pending<Feature> = modal 表示用
state.craftTeam            // <feature>Team = フォーム入力中チーム
```

### 3.2 配列の単数 vs 複数

```js
const heroes = HERO_ROSTER;       // 配列は複数形
const hero = heroes[0];           // 単一は単数形
const heroIds = heroes.map(h => h.heroId);  // 配列は複数形
```

## 4. i18n キー命名

```
<feature>.<context>.<aspect>
```

| キー | 意味 |
|---|---|
| `nav.proceed` | feature=nav, aspect=proceed |
| `craft.mai.busy` | feature=craft, context=mai, aspect=busy |
| `quest.detail.questLv` | feature=quest, context=detail, aspect=questLv |
| `mai.craftBusy` | feature=mai (= キャラ専用) |
| `btn.close` | 共通ボタン |
| `enhance.rankUpBtn.label` | ボタンラベル (= variable 含む場合 `.label`) |

### 4.1 命名規則

- camelCase の単語をドットで連結
- 階層は最大 3 段
- 共通要素は最上位に: `btn.*`, `nav.*`, `unit.*`
- キャラ専用 popup は `mai.*`, `narrator.*` など

## 5. JSDoc コメント

最低限のもの:

```js
/**
 * クラフト完了時の処理 (= modal 表示 + state 更新)
 * @param {Object} ac - active craft state
 * @param {number} slotIdx - 0 (legacy) | 1 | 2
 */
function triggerCraftCompletion(ac, slotIdx) {
  // ...
}

/**
 * @param {number} heroId
 * @returns {Object|null}
 */
function findHeroById(heroId) {
  return HERO_DEFS[String(heroId)] || null;
}
```

公開 API (= export) は必須。 内部関数は複雑な場合のみ。

## 6. コミットメッセージ (Conventional Commits)

```
<type>(<scope>): <subject>

[body]

[footer]
```

### 6.1 type

| type | 用途 |
|---|---|
| `feat` | 新機能 |
| `fix` | バグ修正 |
| `refactor` | 機能変更なしのリファクタ |
| `style` | フォーマットのみ |
| `docs` | ドキュメントのみ |
| `test` | テストのみ |
| `chore` | ビルド・依存関係・設定 |
| `perf` | パフォーマンス改善 |

### 6.2 scope

各プロジェクトのフェーズ ID:

```
feat(spec-006): Phase 1D-42 — Add parallel craft slots accessor
fix(spec-007): Phase 1F-3 — Salary popup time leak
docs(spec-001): Update PROJECT_CHARTER.md
```

### 6.3 subject

- 50 文字以下
- 命令形 (= "Add", "Fix", "Update")
- 末尾にピリオドなし
- 日本語 OK (= 英語と混在 OK)

### 6.4 body (任意)

```
feat(spec-006): Phase 1D-47 — Fix maiSays double pause leak

Caller の事前 pauseTime() を maiSays が消費するように変更。
具体的には state.pauseFlags === 0 の場合のみ自前で pause する。

これにより triggerSalaryAdvanceWarning → maiSays チェーン中の
pauseFlags 累積が解消され、 onTick の早期 return による
時間フリーズが発生しなくなった。
```

### 6.5 footer

```
Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
```

## 7. PR 命名と本文

### 7.1 タイトル

```
[<scope>] <type>: <subject>
```

例:
```
[spec-006] feat: Phase 1D-42 — Add parallel craft slots
[spec-007] fix: Quest "休憩して再出発" doesn't unlock heroes
[spec-008] docs: Update DEVELOPMENT_CHARTER.md
```

### 7.2 本文 (= テンプレート)

```markdown
## Summary

<3 行以内で何をやったか>

## Why

<なぜやったか / どんな問題を解決したか>

## Changes

- <具体的な変更点>
- ...

## Test plan

- [ ] <手動 QA>
- [ ] <自動テスト>
- [ ] <regression>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

## 8. ブランチ命名

```
<type>/<spec-id>-<phase>-<short-desc>
```

例:
```
feat/spec-006-phase-1d-42-parallel-slots
fix/spec-007-phase-1f-3-salary-leak
docs/spec-001-update-charters
```

## 9. 一般的なベストプラクティス

### 9.1 import 順序

```js
// 1. 標準 (= なし、 vanilla JS なので)

// 2. 内部 lib
import { state } from "./state.js";
import { t, ti18n } from "./i18n.js";

// 3. 機能 module
import { triggerConfetti } from "./effects.js";
import { submitScore, fetchRanking } from "./ranking-client.js";

// 4. 同階層
import { renderHeader } from "./header.js";
```

### 9.2 const 優先

```js
// 良い
const HERO_DEFS = {};
const TICK_INTERVAL_MS = 1000;

// 悪い
let HERO_DEFS = {};                    // ← let が必要な場合のみ let
var TICK_INTERVAL_MS = 1000;           // ← var は使わない
```

### 9.3 enum 代替: `Object.freeze`

```js
export const QUEST_STATUS = Object.freeze({
  IDLE: "idle",
  ACTIVE: "active",
  PENDING_RESULT: "pending_result",
  COMPLETED: "completed",
});

// 利用
if (state.activeQuest?.status === QUEST_STATUS.PENDING_RESULT) { ... }
```

### 9.4 magic number は const に

```js
// 悪い
if (state.weekProgress >= 7) advanceWeek();

// 良い
const SECONDS_PER_WEEK = 7;
if (state.weekProgress >= SECONDS_PER_WEEK) advanceWeek();
```

## 10. テストケース (= self-doc)

各 feature の最後にテストチェックリストを置く:

```markdown
## テストケース

- [ ] 通常フロー (= 1 hero × 1 craft で完了する)
- [ ] エッジ: 0 hero
- [ ] エッジ: max hero (= slot 上限)
- [ ] 失敗フロー (= 資源不足)
- [ ] 連続実行 (= 5 回連続でクラッシュしないか)
- [ ] 言語切替時に表示が崩れないか
```

これは `docs/patterns/04-time-and-modals.md` 等の各章末にも入れている。
