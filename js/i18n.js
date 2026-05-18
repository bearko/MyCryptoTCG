// ============================================================
// i18n.js — 多言語サポート
// ============================================================

import { LS_LANG } from "./constants.js";

const DEFAULT_LANG = "ja";

let _lang = DEFAULT_LANG;
let _ui = null;
let _ready = false;
const _listeners = new Set();

export function getLang() { return _lang; }

export function isReady() { return _ready; }

export function onLangChange(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

export function setLang(lang) {
  if (lang !== "ja" && lang !== "en") return;
  if (lang === _lang) return;
  _lang = lang;
  try { localStorage.setItem(LS_LANG, lang); } catch (e) {}
  document.documentElement.setAttribute("lang", lang);
  applyDataI18n(document);
  for (const fn of _listeners) {
    try { fn(lang); } catch (e) { console.error("lang listener", e); }
  }
}

export async function initI18n() {
  try {
    const stored = localStorage.getItem(LS_LANG);
    if (stored === "ja" || stored === "en") _lang = stored;
  } catch (e) {}
  document.documentElement.setAttribute("lang", _lang);

  const ui = await fetch("data/i18n/ui.json")
    .then((r) => r.ok ? r.json() : {})
    .catch(() => ({}));
  _ui = ui;
  _ready = true;

  applyDataI18n(document);
}

/**
 * @param {string} key
 * @param {string} [fallback]
 * @returns {string}
 */
export function t(key, fallback) {
  if (!_ui) return fallback ?? key;
  const entry = _ui[key];
  if (!entry) return fallback ?? key;
  if (typeof entry === "string") return entry;
  return entry[_lang] ?? entry.ja ?? fallback ?? key;
}

// alias
export const ti18n = t;

/**
 * data-i18n 系属性を持つ DOM ノードに翻訳を適用する
 * @param {Document|Element} root
 */
export function applyDataI18n(root) {
  const r = root || document;

  // [data-i18n="key"] → element.textContent
  r.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (!key) return;
    const v = t(key);
    if (v != null) el.textContent = v;
  });

  // [data-i18n-html="key"] → element.innerHTML (= 信頼ソースのみ)
  r.querySelectorAll("[data-i18n-html]").forEach((el) => {
    const key = el.getAttribute("data-i18n-html");
    if (!key) return;
    const v = t(key);
    if (v != null) el.innerHTML = v;
  });

  // [data-i18n-attr-<attr>="key"] → element.setAttribute(attr, value)
  r.querySelectorAll("*").forEach((el) => {
    for (const a of Array.from(el.attributes)) {
      if (!a.name.startsWith("data-i18n-attr-")) continue;
      const targetAttr = a.name.slice("data-i18n-attr-".length);
      const v = t(a.value);
      if (v != null) el.setAttribute(targetAttr, v);
    }
  });
}

/**
 * テンプレート内の {var} を引数で置換する簡易関数
 * @example tpl("hello {name}", { name: "Bob" })
 */
export function tpl(s, vars) {
  return String(s).replace(/\{(\w+)\}/g, (_, k) =>
    (vars && k in vars) ? String(vars[k]) : `{${k}}`
  );
}
