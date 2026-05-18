# Pattern 03 — 多言語 (i18n) とヘルプ

## 1. データ構造

`data/i18n/ui.json`:

```json
{
  "lang.toggle.label":   { "ja": "言語 / Language", "en": "Language / 言語" },
  "title.press":         { "ja": "Press to Start", "en": "Press to Start" },
  "alpha.badge":         { "ja": "β2 版 / BETA2",   "en": "β2 / BETA2" },
  "btn.close":           { "ja": "閉じる",          "en": "Close" },
  "enhance.rankUpBtn":   { "ja": "ランクアップ ({rank}→{next}) {gum} GUM",
                           "en": "Rank up ({rank}→{next}) {gum} GUM" },
  "salary.notif.firstYearWaived": {
    "ja": "初年度のため年俸支払いは免除されました",
    "en": "Year 1 subsidy: salary waived"
  }
}
```

形式は **2 種**:
1. 単純文字列 (= 全 lang 共通) → `"key": "text"`
2. Object (= lang 別) → `"key": { "ja": "...", "en": "..." }`

## 2. キー命名規則

階層: `<feature>.<context>.<aspect>` 例:

| Key | 意味 |
|---|---|
| `nav.proceed` | ナビゲーションの「進む」 |
| `craft.mai.busy` | クラフト feature の Mai セリフ busy ケース |
| `quest.detail.questLv` | クエスト詳細パネルの Quest Lv ラベル |
| `mai.craftBusy` | Mai キャラ専用 popup (= prefix `mai.`) |
| `btn.close` / `btn.confirm` | 共通ボタン |
| `enhance.rankUpBtn` | 強化画面のランクアップボタン (= variable 含む) |

### Variable 置換

`{var}` を runtime で置換:

```js
const tmpl = ti18n("enhance.rankUpBtn");
const text = tmpl
  .replace("{rank}", String(currentRank))
  .replace("{next}", String(currentRank + 1))
  .replace("{gum}",  cost.toLocaleString());
```

## 3. ローカル loader

`js/i18n.js`:

```js
const LANG_KEY = "<prefix>.lang";   // 例: "mcf.lang"
const DEFAULT_LANG = "ja";

let _lang = DEFAULT_LANG;
let _ui = null;
let _ready = false;
const _listeners = new Set();

export function getLang() { return _lang; }

export function setLang(lang) {
  if (lang !== "ja" && lang !== "en") return;
  if (lang === _lang) return;
  _lang = lang;
  try { localStorage.setItem(LANG_KEY, lang); } catch (e) {}
  document.documentElement.setAttribute("lang", lang);
  applyDataI18n(document);
  for (const fn of _listeners) {
    try { fn(lang); } catch (e) { console.error("lang listener", e); }
  }
}

export async function initI18n() {
  try {
    const stored = localStorage.getItem(LANG_KEY);
    if (stored === "ja" || stored === "en") _lang = stored;
  } catch (e) {}
  document.documentElement.setAttribute("lang", _lang);

  const ui = await fetch("data/i18n/ui.json")
    .then(r => r.json())
    .catch(() => ({}));
  _ui = ui;
  _ready = true;
}

export function t(key, fallback) {
  if (!_ui) return fallback ?? key;
  const entry = _ui[key];
  if (!entry) return fallback ?? key;
  if (typeof entry === "string") return entry;
  return entry[_lang] ?? entry.ja ?? fallback ?? key;
}

// alias
export const ti18n = t;
```

## 4. data-i18n 属性で DOM 自動更新

HTML:

```html
<button data-i18n="btn.close">閉じる</button>
<p data-i18n="alpha.note">β 版です。</p>
<input type="text" data-i18n-attr-placeholder="hire.namePlaceholder" placeholder="名前" />
<div data-i18n-html="footer.credit">© ...</div>
```

JS:

```js
export function applyDataI18n(root) {
  const r = root || document;

  // [data-i18n="key"] → element.textContent
  r.querySelectorAll("[data-i18n]").forEach(el => {
    const key = el.getAttribute("data-i18n");
    if (!key) return;
    const v = t(key);
    if (v != null) el.textContent = v;
  });

  // [data-i18n-html="key"] → element.innerHTML (= 信頼ソースのみ)
  r.querySelectorAll("[data-i18n-html]").forEach(el => {
    const key = el.getAttribute("data-i18n-html");
    if (!key) return;
    const v = t(key);
    if (v != null) el.innerHTML = v;
  });

  // [data-i18n-attr-<attr>="key"] → element.setAttribute(attr, value)
  r.querySelectorAll("*").forEach(el => {
    for (const a of Array.from(el.attributes)) {
      if (!a.name.startsWith("data-i18n-attr-")) continue;
      const targetAttr = a.name.slice("data-i18n-attr-".length);
      const v = t(a.value);
      if (v != null) el.setAttribute(targetAttr, v);
    }
  });
}
```

## 5. 言語トグル UI

タイトル画面 + ホーム header の両方:

```html
<div class="lang-toggle" id="langToggle">
  <span class="lang-toggle-label" data-i18n="lang.toggle.label">Language / 言語</span>
  <div class="lang-toggle-buttons">
    <button class="lang-btn" data-lang="ja">JP：日本語</button>
    <button class="lang-btn" data-lang="en">EN：English</button>
  </div>
</div>
```

```js
$("#langToggle").addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-lang]");
  if (!btn) return;
  setLang(btn.getAttribute("data-lang"));
  // active class 更新
  $$(".lang-btn").forEach(b => {
    b.classList.toggle("lang-btn--active", b.getAttribute("data-lang") === getLang());
  });
});

// ヘッダーボタン (= 1 クリックでトグル)
$("#btnLangToggle")?.addEventListener("click", () => {
  setLang(getLang() === "en" ? "ja" : "en");
});
```

## 6. ヘルプオーバーレイ

```html
<div id="helpOverlay" class="help-overlay hidden">
  <div class="help-card">
    <h2 data-i18n="help.title">ヘルプ</h2>
    <p data-i18n="help.body">ゲーム概要文…</p>
    <p data-i18n="help.timeNote">ホーム画面で待機している間のみ時間が進行します…</p>
    <button id="btnHelpClose" data-i18n="btn.close">閉じる</button>
  </div>
</div>
```

```js
function openHelp() {
  pauseTime();
  $("#helpOverlay").classList.remove("hidden");
  document.body.style.overflow = "hidden";
}
function closeHelp() {
  $("#helpOverlay").classList.add("hidden");
  document.body.style.overflow = "";
  resumeTime();
}

$("#btnHelpOpen").addEventListener("click", openHelp);
$("#btnHelpClose").addEventListener("click", closeHelp);
$("#helpOverlay").addEventListener("click", (e) => {
  if (e.target.id === "helpOverlay") closeHelp();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#helpOverlay").classList.contains("hidden")) {
    closeHelp();
  }
});
```

## 7. ドメイン固有翻訳 (= ヒーロー名・敵名・アイテム名)

UI 文字列以外 (= ヒーロー名 など) は別ファイルに分割:

`data/i18n/heroes-en.json`:
```json
[
  { "id": 1, "name": "Conan Doyle" },
  { "id": 2, "name": "Yatagarasu" }
]
```

`js/i18n.js`:
```js
let _heroes = null;

// initI18n() 内で:
_heroes = await fetch("data/i18n/heroes-en.json").then(r => r.json()).catch(() => []);

export function tHero(heroId, jaName) {
  if (_lang === "ja") return jaName ?? "";
  const e = _heroes?.find(x => x.id === heroId);
  return (e && e.name) ? e.name : (jaName ?? "");
}
```

## 8. Runtime テキスト翻訳 (= ログ等の動的文字列)

```js
const RUNTIME_REPLACEMENTS = [
  [/(\d+)\s*ダメージ/g, "$1 damage"],
  [/(\d+)\s*回復/g, "$1 heal"],
];

export function translateGameText(text) {
  if (_lang === "ja" || !text) return text ?? "";
  let out = String(text);
  for (const [pat, rep] of RUNTIME_REPLACEMENTS) {
    out = out.replace(pat, rep);
  }
  return out.trim();
}
```

## 9. テストケース

- [ ] 起動時に言語が `localStorage` から復元される
- [ ] タイトル画面で JP/EN 切替 → 全文字列が即座に切り替わる
- [ ] 未翻訳キーで fallback 表示 (= 日本語 or キー名)
- [ ] `{var}` 置換が正しく動く
- [ ] data-i18n-attr-placeholder が input 要素に効く
- [ ] ヘルプオーバーレイが Esc で閉じる
- [ ] ヒーロー名が EN に切り替わる
