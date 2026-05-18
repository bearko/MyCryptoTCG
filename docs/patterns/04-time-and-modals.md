# Pattern 04 — 時間制御とモーダル設計

このテンプレートで **最も重要な** ファイル。 過去の双子プロジェクトで複数回バグが発生した領域。

## 1. State の pauseFlags

```js
const state = {
  pauseFlags: 0,    // != 0 で時間停止 (counter 式)
  tickCount: 0,
  // ...
};

function pauseTime()  { state.pauseFlags++; }
function resumeTime() { state.pauseFlags = Math.max(0, state.pauseFlags - 1); }
```

`Math.max(0, ...)` は重要: 万一 resume が pause より多くてもマイナスにならない。

## 2. onTick の冒頭ガード

```js
const TICK_INTERVAL_MS = 1000;
let _tickHandle = null;

function startTimeLoop() {
  if (_tickHandle) return;
  _tickHandle = setInterval(onTick, currentTickInterval());
}
function stopTimeLoop() {
  if (_tickHandle) { clearInterval(_tickHandle); _tickHandle = null; }
}
function currentTickInterval() {
  if (state.timeSpeed20x) return Math.round(TICK_INTERVAL_MS / 20);
  if (state.timeSpeed2x)  return Math.round(TICK_INTERVAL_MS / 2);
  return TICK_INTERVAL_MS;
}

function onTick() {
  if (state.pauseFlags > 0) return;   // ← pause 中は何もしない
  state.tickCount++;
  state.weekProgress++;
  if (state.weekProgress >= SECONDS_PER_WEEK) advanceWeek();
  // ... per-tick simulations ...
}
```

## 3. Modal 開閉と pause/resume の対応

### 3.1 単発 modal

```js
function openMyModal() {
  pauseTime();                                  // ← +1
  $("#myModal").classList.remove("hidden");
}
function closeMyModal() {
  $("#myModal").classList.add("hidden");
  resumeTime();                                 // ← -1 (= ペア)
}
```

### 3.2 連鎖 modal (= A → B → C と移る)

```js
function openA() {
  pauseTime();
  $("#A").classList.remove("hidden");
}
function closeA() {
  $("#A").classList.add("hidden");
  resumeTime();
  openB();   // ← onClose で次を開く
}
function openB() {
  pauseTime();   // ← B が自分で pause
  $("#B").classList.remove("hidden");
}
function closeB() {
  $("#B").classList.add("hidden");
  resumeTime();
  openC();
}
// ...
```

各 modal が自前で pause/resume する。 親が「resume してから次を開く」 ことで pauseFlags の累積を防ぐ。

## 4. maiSays / maiSaysSequence のオーナーシップ問題

これは MCF Phase 1D-47 で遭遇した難問:

### 4.1 当初の設計 (= 二重 pause leak バグ)

```js
function maiSays(key, options) {
  pauseTime();    // ← 必ず pause
  $("#maiModal").classList.remove("hidden");
  _maiNextAction = options.onClose;
}
function closeMaiModal() {
  $("#maiModal").classList.add("hidden");
  resumeTime();   // ← 必ず resume (= 1 回)
  if (_maiNextAction) _maiNextAction();
}
```

**問題**: 呼出側が事前に `pauseTime()` していると:
- caller pause (+1) → maiSays pause (+1) → close resume (-1) = +1 leak
- 連続イベントで pauseFlags が累積し、 onTick の早期 return で **時間がフリーズ**

### 4.2 修正: 「既に paused なら自前 pause を skip」

```js
function maiSays(key, options) {
  $("#maiModal").classList.remove("hidden");
  // ★ 修正: caller pre-pause を消費するように
  if (state.pauseFlags === 0) pauseTime();
  _maiNextAction = options.onClose;
}
function closeMaiModal() {
  $("#maiModal").classList.add("hidden");
  resumeTime();   // ← 必ず resume を 1 回
  if (_maiNextAction) _maiNextAction();
}
```

**動作**:
- caller pause (+1) → maiSays skip (= 既に paused) → close resume (-1) = 0 ✓
- caller no-pause → maiSays pause (+1) → close resume (-1) = 0 ✓

### 4.3 注意: onClose チェーン中の pause

`onClose` で次の modal を開くケース:

```js
maiSays("comp.maiNotice", { onClose: openCompletionScreen });
//                                  ↑ ここで pauseTime が必要
```

`closeMaiModal` の最後で resume された後、 `openCompletionScreen` が自前で `pauseTime()` する設計にしておくと、 modal 連鎖中も時間停止が連続する。

**openCompletionScreen で pauseTime を忘れると、 modal 表示中に time が進む** (= MCF で実際に発生したバグ)。

## 5. デバッグ用 console 出力

開発中はカウンタを可視化:

```js
function pauseTime() {
  state.pauseFlags++;
  if (DEBUG_PAUSE) console.log(`[pause] +1 → ${state.pauseFlags}`, new Error().stack.split("\n")[2]);
}
function resumeTime() {
  state.pauseFlags = Math.max(0, state.pauseFlags - 1);
  if (DEBUG_PAUSE) console.log(`[pause] -1 → ${state.pauseFlags}`, new Error().stack.split("\n")[2]);
}
```

`DEBUG_PAUSE = true` にして、 modal 開閉時に pause が +1 / -1 で対称になっているか確認。

## 6. ペアテーブル (= 派生プロジェクトでも維持)

| 操作 | pauseTime のあり場所 | resumeTime のあり場所 |
|---|---|---|
| Modal 単発 | `openModal()` 冒頭 | `closeModal()` 末尾 |
| Mai popup | `maiSays()` 内 (条件付き) | `closeMaiModal()` 内 |
| Modal チェイン | 各 modal が自前 | 各 modal が自前 |
| Help overlay | `openHelp()` 内 | `closeHelp()` 内 |
| Settings | `openSettings()` 内 | `closeSettings()` 内 |
| 起動 splash | `init()` 冒頭 | データロード完了後 |

## 7. 時間進行が「止まらない」 / 「止まりっぱなし」 のデバッグ

```js
// console で確認
state.pauseFlags  // 0 なら進行中、 > 0 なら停止中

// 強制リセット (= 開発時のみ)
state.pauseFlags = 0;
```

**「止まらない」** = 開いた modal が pause していない:
- `openXxxModal` 関数を grep して `pauseTime()` があるか確認
- onClose チェーンで漏れていないか

**「止まりっぱなし」** = どこかで pauseTime したまま resume されていない:
- 連続イベント (= 月次年俸 → 採用 → コンテスト) のあと再現するか
- DEBUG_PAUSE で stack trace を取って漏れ箇所を特定

## 8. テストケース

- [ ] Modal を 5 つ開閉して pauseFlags が 0 に戻るか
- [ ] maiSaysSequence の途中で別 modal を開いても freeze しないか
- [ ] 月次イベント連続発火 (= 1月警告 + 4月年俸 + 5月採用 + 5月マルコ + 12月コンテスト) で freeze しないか
- [ ] Esc で modal を閉じても resume されるか
- [ ] リロード直後、 pauseFlags が 0 か
