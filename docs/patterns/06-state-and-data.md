# Pattern 06 — State 設計とデータ管理

## 1. 単一 state オブジェクト

```js
const state = {
  // 永続化系 (= 必要なら save/load)
  tickCount: 0,
  weekProgress: 0,
  year: 2018, month: 12, week: 1,
  startYear: 2018,
  
  // プレイヤー資源
  gum: 1000,
  materials: {},
  warehouse: [],
  ownedHeroes: [],
  
  // 進行中アクション (= 単数フィールド + 並列スロット)
  activeCraft: null,
  activeCraftExtra: [null, null],   // slot 1, 2 (= Lv2+ 解放)
  activeQuest: null,
  activeQuestExtra: [null, null],
  activeHire: null,
  activeSales: [],
  
  // Pending modal データ
  pendingCompletion: null,
  pendingAppraisal: null,
  pendingSalaryReport: null,
  pendingMarcoPolo: null,
  pendingContest: null,
  pendingQuestResult: null,
  pendingQuestRedeploy: null,
  
  // フォーム状態
  craftTeam: [null, null, null, null, null],
  questTeam: [null, null, null],
  craftPickedExtId: null,
  questPickedNodeId: null,
  
  // 表示中スロット (= ページャ index)
  craftViewSlotIdx: 0,
  questViewSlotIdx: 0,
  
  // メタ
  pauseFlags: 0,
  monthlyEventsFired: new Set(),
  notifications: [],
  
  // UI 切替
  factoryLevel: 1,
  language: "ja",
  timeSpeed2x: false,
  timeSpeed20x: false,
};
```

## 2. JSON loader パターン

```js
let _heroesPromise = null;
export const HERO_ROSTER = [];
export const HERO_DEFS = {};

export function loadHeroes() {
  if (_heroesPromise) return _heroesPromise;
  _heroesPromise = fetch("./data/heroes.json")
    .then(r => {
      if (!r.ok) throw new Error(`heroes.json fetch failed: ${r.status}`);
      return r.json();
    })
    .then(arr => {
      HERO_ROSTER.length = 0;
      Object.keys(HERO_DEFS).forEach(k => delete HERO_DEFS[k]);
      for (const h of arr) {
        const hero = { ...h, img: () => img(`Image/Heroes/${h.heroId}.png`) };
        HERO_ROSTER.push(hero);
        HERO_DEFS[String(h.heroId)] = hero;
      }
      return HERO_ROSTER;
    });
  return _heroesPromise;
}
```

main.js:
```js
async function init() {
  await Promise.all([loadHeroes(), loadExtensions(), loadShopItems()]);
  // ...
  startTimeLoop();
}
```

## 3. 並列スロット (= Slot Accessor パターン)

旧コードの `state.activeCraft` (= 単数) を残しつつ、 新機能で `activeCraftExtra` を併設:

```js
function parallelCraftSlotsFor(level) {
  if (level >= 3) return 3;
  if (level >= 2) return 2;
  return 1;
}

export function getActiveCraft(idx) {
  if (idx === 0) return state.activeCraft || null;
  return state.activeCraftExtra?.[idx - 1] || null;
}

export function setActiveCraft(idx, ac) {
  if (idx === 0) { state.activeCraft = ac; return; }
  if (!Array.isArray(state.activeCraftExtra)) state.activeCraftExtra = [null, null];
  if (idx >= 1 && idx <= 2) state.activeCraftExtra[idx - 1] = ac;
}

export function forEachCraftSlot(fn) {
  fn(0, state.activeCraft);
  if (Array.isArray(state.activeCraftExtra)) {
    state.activeCraftExtra.forEach((ac, i) => fn(i + 1, ac));
  }
}

export function findEmptyCraftSlot() {
  if (!state.activeCraft) return 0;
  if (!Array.isArray(state.activeCraftExtra)) return 1;
  for (let i = 0; i < state.activeCraftExtra.length; i++) {
    if (!state.activeCraftExtra[i]) return i + 1;
  }
  return -1;
}
```

利用:
```js
function onTick() {
  if (state.pauseFlags > 0) return;
  state.tickCount++;
  forEachCraftSlot((idx, ac) => {
    if (ac) tickActiveCraft(idx);
  });
}

function tickActiveCraft(craftSlotIdx) {
  const ac = getActiveCraft(craftSlotIdx);
  if (!ac) return;
  // ... ac.progress を更新 ...
  if (ac.timeProgress >= 1) {
    triggerCraftCompletion(ac, craftSlotIdx);
  }
}
```

## 4. 月次イベント Dedup Set

```js
state.monthlyEventsFired // Set<"{year}-{eventKey}">

function checkMonthlyEvents() {
  if (!(state.monthlyEventsFired instanceof Set)) {
    state.monthlyEventsFired = new Set(state.monthlyEventsFired || []);
  }

  // 1月4週: 年俸事前警告
  if (state.month === 1 && state.week === 4) {
    const key = `${state.year}-salaryWarn`;
    if (!state.monthlyEventsFired.has(key)) {
      state.monthlyEventsFired.add(key);
      const isFirstYear = state.year === state.startYear + 1;
      if (!isFirstYear) setTimeout(triggerSalaryAdvanceWarning, 200);
    }
  }
  
  // 4月1週: 年俸支払い
  if (state.month === 4 && state.week === 1) {
    const key = `${state.year}-salary`;
    if (!state.monthlyEventsFired.has(key)) {
      state.monthlyEventsFired.add(key);
      const isFirstYear = state.year === state.startYear + 1;
      if (isFirstYear) setTimeout(triggerFirstYearSalarySubsidy, 200);
      else            setTimeout(triggerAnnualSalary, 200);
    }
  }
  
  // 5月1週: 採用イベント
  if (state.month === 5 && state.week === 1) {
    const key = `${state.year}-recruit`;
    if (!state.monthlyEventsFired.has(key)) {
      state.monthlyEventsFired.add(key);
      setTimeout(triggerRecruitmentEvent, 200);
    }
  }
  
  // 5月3週: 行商人マルコ・ポーロ
  if (state.month === 5 && state.week === 3) {
    const key = `${state.year}-marcopolo`;
    if (!state.monthlyEventsFired.has(key)) {
      state.monthlyEventsFired.add(key);
      setTimeout(triggerMarcoPoloVisit, 200);
    }
  }
  
  // 12月1週: コンテスト
  if (state.month === 12 && state.week === 1) {
    const key = `${state.year}-contest`;
    if (!state.monthlyEventsFired.has(key)) {
      state.monthlyEventsFired.add(key);
      const isYr1 = state.year <= state.startYear + 1;
      if (!isYr1) setTimeout(triggerExtensionContest, 200);
    }
  }
}
```

## 5. Deterministic Recipe / 抽選 (= seed 乱数)

`xorshift32` ベース:

```js
function seededRand(seed, salt) {
  let x = (seed * 2654435761 ^ salt * 1597334677) >>> 0;
  x ^= x << 13; x >>>= 0;
  x ^= x >>> 17; x >>>= 0;
  x ^= x << 5;  x >>>= 0;
  return x / 0xFFFFFFFF;
}

function pickNFromList(list, n, seed, saltBase) {
  const pool = list.slice();
  const out = [];
  for (let k = 0; k < n && pool.length > 0; k++) {
    const idx = Math.floor(seededRand(seed, saltBase + k) * pool.length) % pool.length;
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

export function recipeFor(ext) {
  if (!ext) return [];
  const seed = ext.extId || 0;
  const normals = pickNFromList(NORMAL_MATERIAL_IDS, 2, seed, 100);
  const land    = pickNFromList(LAND_MATERIAL_IDS,   1, seed, 200);
  const sum = (ext.params?.hp ?? 0) + (ext.params?.phy ?? 0) +
              (ext.params?.int ?? 0) + (ext.params?.agi ?? 0);
  const baseQty = Math.max(1, Math.ceil(sum / 30));
  return [
    { id: normals[0], qty: baseQty },
    { id: normals[1], qty: Math.max(1, Math.ceil(baseQty / 2)) },
    { id: land[0],    qty: 1 },
  ];
}
```

利点: **同じ ext id は常に同じレシピ** → ユーザー体験が安定 + テストしやすい。

## 6. Pending state の clean-up 規律

modal 表示中に使う一時データは `pending*` に置く。 close 時に必ず null にする:

```js
function openSalaryReportModal() {
  // (= triggerAnnualSalary が pendingSalaryReport を set 済み)
  pauseTime();
  $("#salaryReportModal").classList.remove("hidden");
}
function closeSalaryReportModal() {
  $("#salaryReportModal").classList.add("hidden");
  state.pendingSalaryReport = null;   // ★ 必ず null
  resumeTime();
  renderHeader();
  checkDeficitTransition();
}
```

`pending*` を null にしないと、 次回 modal を開いたときに古いデータが表示される。

## 7. Save / Load (= 将来対応)

```js
const SAVE_KEY = "<prefix>.save.v1";

function serializeState() {
  return {
    tickCount: state.tickCount,
    year: state.year, month: state.month, week: state.week,
    gum: state.gum,
    materials: state.materials,
    warehouse: state.warehouse,
    ownedHeroes: state.ownedHeroes.map(h => ({ heroId: h.heroId, rank: h.rank, ... })),
    monthlyEventsFired: Array.from(state.monthlyEventsFired),
    // pendingXXX は持ち越さない (= modal は閉じてから save)
  };
}

function applyLoadedState(s) {
  state.tickCount = s.tickCount || 0;
  state.year = s.year || 2018;
  // ...
  state.monthlyEventsFired = new Set(s.monthlyEventsFired || []);
}
```

## 8. データ JSON のスキーマ管理

各 JSON に `version` フィールドを入れて将来の migration に備える:

```json
{
  "version": 2,
  "items": [...]
}
```

loader 側:
```js
.then(data => {
  if (data.version !== 2) {
    console.warn("data version mismatch", data.version);
    // migration
  }
  return data.items;
})
```
