// ============================================================
// ranking-client.js — ランキング API クライアント (= Backend A / B 共通)
// ============================================================
//
// このクライアントは backend-agnostic。 同じ API 契約 (POST/GET +
// {ok, ranking, error}) を満たすサーバーなら、 URL 差し替えだけで両方で動く。
// 詳細は docs/process/RANKING_SETUP.md を参照。
//
// 既定 (= Backend B / Upstash + Vercel Function) で派生を作る場合:
//   const _DEFAULT_API_URL_ENC = "L2FwaS9yYW5raW5n";   // = btoa("/api/ranking")
//
// 代替 (= Backend A / Google Apps Script) で派生を作る場合:
//   const _DEFAULT_API_URL_ENC = "<btoa('https://script.google.com/macros/s/.../exec')>";
//
// テンプレート本体は **空文字のまま** にしておくこと (= 派生で書き換える前提、
// サンプル URL を残すと全派生がそこに POST してしまう)。
// ============================================================

import { LS_RANKING_API_URL, LS_PLAYER_NAME } from "./constants.js";

const _DEFAULT_API_URL_ENC = "";

function _decodeDefault() {
  try {
    if (!_DEFAULT_API_URL_ENC) return null;
    return typeof atob === "function" ? atob(_DEFAULT_API_URL_ENC) : null;
  } catch (e) { return null; }
}

export function getRankingApiUrl() {
  try {
    const v = localStorage.getItem(LS_RANKING_API_URL);
    if (v && v.trim()) return v.trim();
  } catch (e) {}
  const def = _decodeDefault();
  return (def && def.trim()) ? def.trim() : null;
}

export function setRankingApiUrl(url) {
  try {
    if (!url || !url.trim()) localStorage.removeItem(LS_RANKING_API_URL);
    else localStorage.setItem(LS_RANKING_API_URL, url.trim());
  } catch (e) {}
}

// 未設定時は "anonymous" を返す (= 名前欄を空のまま送信しても弾かれない)。
// 詳細: docs/process/RANKING_SETUP.md 3 章 + survivor SPEC-038。
const DEFAULT_PLAYER_NAME = "anonymous";

export function getPlayerName() {
  try {
    const v = localStorage.getItem(LS_PLAYER_NAME);
    return (v && v.trim()) ? v : DEFAULT_PLAYER_NAME;
  } catch (e) { return DEFAULT_PLAYER_NAME; }
}

export function setPlayerName(name) {
  try {
    const trimmed = (name || "").trim().slice(0, 30);
    if (!trimmed) localStorage.removeItem(LS_PLAYER_NAME);
    else localStorage.setItem(LS_PLAYER_NAME, trimmed);
  } catch (e) {}
}

/**
 * @param {Object} payload - { playerName, score, version, ... }
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function submitScore(payload) {
  const url = getRankingApiUrl();
  if (!url) return { ok: false, error: "ランキング API URL が未設定" };
  try {
    const body = { ...payload, timestamp: new Date().toISOString() };
    const res = await fetch(url, {
      method: "POST",
      mode: "cors",
      cache: "no-cache",
      // ↓ CORS preflight (= OPTIONS) 回避のために text/plain を使う
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json().catch(() => ({}));
    return { ok: !!data.ok, error: data.error };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/**
 * @param {{ regulation?: string, version?: string, limit?: number }} [opts]
 */
export async function fetchRanking(opts = {}) {
  const url = getRankingApiUrl();
  if (!url) return { ok: false, error: "ランキング API URL が未設定", ranking: [] };
  try {
    const params = new URLSearchParams();
    if (opts.regulation) params.set("regulation", opts.regulation);
    if (opts.version)    params.set("version", opts.version);
    if (opts.limit)      params.set("limit", String(opts.limit));
    const fullUrl = params.toString() ? `${url}?${params}` : url;
    const res = await fetch(fullUrl, { method: "GET", mode: "cors", cache: "no-cache" });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, ranking: [] };
    const data = await res.json().catch(() => ({}));
    return { ok: !!data.ok, ranking: data.ranking || [], error: data.error };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), ranking: [] };
  }
}
