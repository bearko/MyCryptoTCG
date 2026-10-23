// ヒーローのセリフと UI 文言（SPEC-110 §3 lines.js / §1.7 / §6）。
// DOM に触れない純粋関数。db.messages は data/messages.json そのもの。

const FALLBACK_TONE = 'plain';

/**
 * ヒーローの口調でメッセージを返す。
 * tone が無い・その口調の文が無いときは plain。ID が無ければ msgId をそのまま返す。
 * {name} は vars に無ければ hero.name を使う。vars に無い差し込みは {key} のまま残す。
 * @param {object} db
 * @param {object|null} hero
 * @param {string} msgId
 * @param {object} [vars]
 * @returns {string}
 */
export function say(db, hero, msgId, vars = {}) {
  const messages = db && db.messages && db.messages.messages;
  const entry = messages && Object.prototype.hasOwnProperty.call(messages, msgId) ? messages[msgId] : null;
  if (!entry) return msgId;
  const tone = hero && hero.tone;
  const text = (tone && entry[tone]) || entry[FALLBACK_TONE];
  if (typeof text !== 'string') return msgId;
  const all = { ...(vars || {}) };
  if (all.name == null && hero && hero.name != null) all.name = hero.name;
  return fill(text, all);
}

/**
 * UI 文言。無いキーはキーそのものを返す。
 * @param {object} db
 * @param {string} key
 * @returns {string}
 */
export function uiText(db, key) {
  const ui = db && db.messages && db.messages.ui;
  return (ui && ui[key]) ?? key;
}

function fill(text, vars) {
  return text.replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? m : String(vars[k])));
}
