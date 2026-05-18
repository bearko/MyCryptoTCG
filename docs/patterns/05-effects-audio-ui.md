# Pattern 05 — エフェクト・音響・UI コンポーネント

## 1. Confetti (= 紙吹雪)

`js/effects.js`:

```js
export function triggerConfetti(count = 50, ms = 3000) {
  const layer = document.getElementById("confettiLayer");
  if (!layer) return;
  layer.classList.remove("hidden");
  layer.innerHTML = "";  // 既存 piece 片付け
  const colors = [
    "#ffd700", "#ff6b9d", "#5ecf8a", "#56ccf2",
    "#bb86fc", "#ff9844", "#f9f871", "#ff5252",
  ];
  const W = window.innerWidth || 800;
  for (let i = 0; i < count; i++) {
    const piece = document.createElement("span");
    piece.className = "confetti-piece";
    piece.style.left = (Math.random() * W) + "px";
    piece.style.background = colors[i % colors.length];
    piece.style.setProperty("--cx", (Math.random() * 200 - 100) + "px");
    piece.style.animationDuration = (1.8 + Math.random() * 1.4).toFixed(2) + "s";
    piece.style.animationDelay    = (Math.random() * 0.6).toFixed(2) + "s";
    layer.appendChild(piece);
  }
  setTimeout(() => {
    layer.classList.add("hidden");
    layer.innerHTML = "";
  }, ms);
}
```

CSS:

```css
.confetti-layer {
  position: fixed; inset: 0;
  pointer-events: none;
  z-index: 200;
}
.confetti-layer.hidden { display: none !important; }
.confetti-piece {
  position: absolute;
  top: -20px;
  width: 10px; height: 14px;
  border-radius: 2px;
  animation-name: confetti-fall;
  animation-fill-mode: forwards;
  animation-timing-function: cubic-bezier(.2,.6,.6,1);
}
@keyframes confetti-fall {
  0%   { transform: translate(0, 0) rotate(0); opacity: 1; }
  100% { transform: translate(var(--cx, 0), 100vh) rotate(720deg); opacity: 0; }
}
```

HTML:
```html
<div id="confettiLayer" class="confetti-layer hidden"></div>
```

## 2. Sprite Float (= +N が浮上して消える)

```js
const _spriteFloats = [];   // queue
let _floatId = 0;
const FLOAT_TTL_MS = 1500;

export function pushSpriteFloat({ heroId, element, value }) {
  _spriteFloats.push({ id: ++_floatId, heroId, element, value, createdAt: Date.now() });
  // GC
  const cutoff = Date.now() - FLOAT_TTL_MS;
  while (_spriteFloats.length && _spriteFloats[0].createdAt < cutoff) {
    _spriteFloats.shift();
  }
  renderSpriteFloats();
}
```

CSS:
```css
.sprite-float {
  position: absolute;
  font-weight: 800; font-size: 0.85rem;
  pointer-events: none;
  animation: float-up 1.4s ease-out forwards;
}
.sprite-float--garuda { color: var(--garuda); }
.sprite-float--ifrit  { color: var(--ifrit); }

@keyframes float-up {
  0%   { transform: translateY(0); opacity: 1; }
  100% { transform: translateY(-32px); opacity: 0; }
}
```

## 3. ポップアップ数値 (= ダメージ・回復)

```css
.stat-pop {
  animation: stat-pop 0.7s ease-out forwards;
}
@keyframes stat-pop {
  0%   { opacity: 1; transform: translateY(0) scale(1); }
  60%  { transform: translateY(-18px) scale(1.15); }
  100% { opacity: 0; transform: translateY(-30px) scale(0.85); }
}
```

## 4. Shake / Lunge (= 戦闘時のヒット演出)

```css
.shake {
  animation: shake 0.32s ease;
}
@keyframes shake {
  0%, 100% { transform: translateX(0); }
  25%      { transform: translateX(-4px); }
  75%      { transform: translateX(4px); }
}

.lunge-right { animation: lunge-right 0.18s ease forwards; }
@keyframes lunge-right {
  to { transform: translateX(18px); }
}
```

JS:
```js
function applyShake(el) {
  el.classList.remove("shake");
  void el.offsetWidth;     // ← reflow を強制してアニメ再起動
  el.classList.add("shake");
}
```

## 5. 音響 — BGM

タイトル画面 dismiss 後に開始 (= autoplay 制限の回避):

```js
let bgmAudio = null;

function startBgmTitle() {
  stopBgm();
  try {
    bgmAudio = new Audio(AUDIO_URLS.bgmTitle());
    bgmAudio.loop = true; bgmAudio.volume = 0.32;
    bgmAudio.play().catch(() => {});
  } catch (_) {}
}
function stopBgm() {
  if (bgmAudio) { bgmAudio.pause(); bgmAudio.currentTime = 0; bgmAudio = null; }
}

// title 画面 dismiss 時 (= ユーザー操作後) に BGM 開始
function dismissTitle() {
  startBgmTitle();
  // ...
}
```

## 6. 音響 — SE

場面別関数で分割。 throttle で連発防止:

```js
const _seThrottle = new Map();   // key → last timestamp

function playSe(name, throttleMs = 80) {
  const now = Date.now();
  const last = _seThrottle.get(name) || 0;
  if (now - last < throttleMs) return;
  _seThrottle.set(name, now);
  try {
    const a = new Audio(AUDIO_URLS["se" + capitalize(name)]());
    a.volume = 0.5;
    a.play().catch(() => {});
  } catch (_) {}
}

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
```

利用例:
```js
playSe("click");      // ボタン
playSe("success");    // 成功
playSe("buff");       // バフ
playSe("damageHit");  // ダメージ
```

## 7. 共通ボタンスタイル

```css
.btn {
  appearance: none;
  background: var(--accent); color: #1a1420;
  border: none; border-radius: 6px;
  padding: 0.55rem 0.9rem;
  font-weight: 800; font-size: 0.9rem;
  cursor: pointer;
  letter-spacing: 0.04em;
  transition: opacity 0.18s, transform 0.1s;
}
.btn:hover  { opacity: 0.9; }
.btn:active { transform: translateY(1px); }
.btn:disabled { opacity: 0.45; cursor: not-allowed; }

.btn--secondary {
  background: rgba(196,163,90,0.12);
  color: var(--accent);
  border: 1.5px solid var(--accent);
}
.btn--ghost {
  background: transparent;
  color: var(--accent);
  border: 1px solid transparent;
}
.btn--ghost:hover { border-color: var(--accent); }

.btn--danger {
  background: transparent;
  color: var(--ifrit);
  border: 1.5px solid var(--ifrit);
}
.btn--danger:hover {
  background: rgba(231,96,96,0.12);
}
```

## 8. 通知タイル (= 一時的な小型 popup)

```js
const _notifications = [];
let _notifId = 0;
const NOTIF_TTL_TICKS = 4;   // 4 tick (= 4 sec)

export function pushNotification({ text, element = "garuda", value = 0 }) {
  _notifications.push({
    id: ++_notifId, text, element, value,
    createdTick: state.tickCount,
  });
  pruneNotifications();
  renderNotifications();
}

function pruneNotifications() {
  const cutoff = state.tickCount - NOTIF_TTL_TICKS;
  while (_notifications.length && _notifications[0].createdTick < cutoff) {
    _notifications.shift();
  }
}
```

```css
.notification {
  position: relative;
  padding: 0.4rem 0.6rem;
  background: var(--panel-2);
  border-left: 3px solid var(--accent);
  border-radius: 4px;
  margin-bottom: 0.3rem;
  font-size: 0.78rem;
  animation: slide-in 0.3s ease;
}
.notification--garuda    { border-left-color: var(--garuda); }
.notification--ifrit     { border-left-color: var(--ifrit); }
.notification--leviathan { border-left-color: var(--leviathan); }
.notification--tiamat    { border-left-color: var(--tiamat); }

@keyframes slide-in {
  from { opacity: 0; transform: translateX(20px); }
  to   { opacity: 1; transform: translateX(0); }
}
```

## 9. CSS 変数で色テーマ統一

```css
:root {
  --bg:        #121018;
  --panel:    #1e1a28;
  --panel-2:  #2a2438;
  --border:   #3d3550;
  --text:     #e6e0f0;
  --muted:    #8c7fb0;
  --accent:   #c4a35a;
}
```

`var(--accent)` を貫徹することで、 後でテーマ切替 / ダークモード対応が容易に。

## 10. Reduced Motion 対応 (= 将来)

```css
@media (prefers-reduced-motion: reduce) {
  .confetti-piece, .sprite-float, .shake, .lunge-right {
    animation: none !important;
    transition: none !important;
  }
}
```

ユーザーが OS で「動きを減らす」 を ON にしている場合は演出を抑制。
