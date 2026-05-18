# Pattern 01 — 動作環境と素材参照

## 1. Viewport (= 必須)

```html
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
```

## 2. Responsive 基盤

`* { box-sizing: border-box }` + flex で全画面レイアウトを固める:

```css
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  font-family: "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif;
  background: radial-gradient(ellipse at top, #1f1a2e 0%, var(--bg) 55%);
  color: var(--text);
  display: flex; flex-direction: column; align-items: center;
  padding: 0.75rem;
}
.wrap { width: 100%; max-width: 900px; }
```

## 3. clamp() で流動レイアウト

固定 px / vw を `clamp(min, mid, max)` で挟む:

```css
.combatant-portrait {
  width:  clamp(46px, 7vw, 110px);
  height: clamp(46px, 7vw, 110px);
}

.title-logo {
  max-width: min(420px, 88vw);
}
```

これで `@media` を 3 つ以下に抑えられる。

## 4. テキスト溢れ対策

### 単行: ellipsis

```css
.hero-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 150px;
}
```

### 複数行: line-clamp

```css
.description {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}
```

### コンテナ scroll で吸収

```css
.scrollable-list {
  overflow-x: auto;
  overflow-y: hidden;
  -ms-overflow-style: none;
}
.scrollable-list::-webkit-scrollbar { display: none; }
```

## 5. PC レイアウト切替

```css
/* デフォルト (= モバイル): 単列 */
.factory-stage {
  display: flex; flex-direction: column;
  gap: 0.7rem;
}

/* PC (880px+): workshop 左 + progress cards 右 */
@media (min-width: 880px) {
  .factory-stage {
    aspect-ratio: 2 / 1;        /* ← 高さ確定の要 */
    flex-direction: row;
  }
  .workshop {
    flex: 1 1 0; max-width: 50%;
  }
}
```

## 6. アセット参照: ASSET_BASE + img() ヘルパー

`js/constants.js`:

```js
export const ASSET_BASE = "https://raw.githubusercontent.com/<your>/<repo>/main/";
export const img = (path) => ASSET_BASE + path;
export const audioUrl = (relPath) => ASSET_BASE + relPath;

// 用途別 URL builder
export const HERO_IMG = (heroId) => img("Image/Heroes/" + heroId + ".png");
export const EXT_IMG  = (extId)  => img("Image/Extensions/" + extId + ".png");

export const AUDIO_URLS = {
  bgmTitle: () => audioUrl("Audio/BGM/title.mp3"),
  bgmMain:  () => audioUrl("Audio/BGM/main.mp3"),
  seClick:  () => audioUrl("Audio/SE/click.mp3"),
  seSuccess: () => audioUrl("Audio/SE/success.mp3"),
};
```

## 7. 画像フォールバック

すべての `<img>` に `onerror` で透明化:

```html
<img src="${heroImg(id)}" alt="${name}"
     onerror="this.style.opacity='0.2'" />
```

これで CDN が落ちていても UI が崩れない。

## 8. Audio フォールバック

```js
function playSe(name) {
  try {
    const a = new Audio(AUDIO_URLS["se" + name]());
    a.volume = 0.5;
    a.play().catch(() => {});  // autoplay 制限を吸収
  } catch (_) {}
}
```

## 9. localStorage フォールバック

```js
function loadPref(key, defaultVal) {
  try {
    const v = localStorage.getItem(key);
    return v != null ? v : defaultVal;
  } catch (e) {
    return defaultVal;
  }
}
```

## 10. データ JSON loader

```js
let _loadingPromise = null;
export const HERO_ROSTER = [];
export const HERO_DEFS = {};

export function loadHeroes() {
  if (_loadingPromise) return _loadingPromise;
  _loadingPromise = fetch("./data/heroes.json")
    .then(r => {
      if (!r.ok) throw new Error(`heroes.json fetch failed: ${r.status}`);
      return r.json();
    })
    .then(arr => {
      HERO_ROSTER.length = 0;
      for (const h of arr) {
        const hero = { ...h, img: () => img(`Image/Heroes/${h.heroId}.png`) };
        HERO_ROSTER.push(hero);
        HERO_DEFS[String(h.heroId)] = hero;
      }
      return HERO_ROSTER;
    });
  return _loadingPromise;
}
```

main.js の init() で `await loadHeroes()` してから利用。

## 11. CDN URL の base64 難読化

ランキング用 GAS URL 等、 リポジトリに直書きしたくないが embed したい場合:

```js
const _DEFAULT_API_URL_ENC = "aHR0cHM6Ly9zY3JpcHQu...";  // base64 encode
function _decodeDefault() {
  try {
    return typeof atob === "function" ? atob(_DEFAULT_API_URL_ENC) : null;
  } catch (e) { return null; }
}
```

これは **暗号ではなく難読化** であることに注意 (= DevTools で見えてしまう)。 機密情報には使わない。
