// ============================================================
// vercel-ranking.js — Vercel Function reference for Backend B
// (= Upstash Redis backend; ranking API)
// ============================================================
//
// このファイルを `api/ranking.js` として repo にコピーすると、 Vercel が
// 自動で `/api/ranking` を Node serverless 関数として deploy する。
// Upstash Redis (= Sorted Set) を ZADD / ZREVRANGE でランキングストアにする。
//
// 必要な環境変数 (Vercel project settings):
//   UPSTASH_REDIS_REST_URL   = https://xxx.upstash.io
//   UPSTASH_REDIS_REST_TOKEN = ********************************
//
// クライアントは `js/ranking-client.js` をそのまま使う (= 変更不要)。
// API URL は同一オリジンの "/api/ranking" を localStorage に設定するか
// `_DEFAULT_API_URL_ENC` に btoa("/api/ranking") = "L2FwaS9yYW5raW5n" を埋め込む。
//
// 依存: なし (= Node 18+ の標準 `fetch` のみ、 `package.json` 不要)
// 詳細: docs/process/RANKING_SETUP.md の 「Backend B」 章
// ============================================================

const MAX_SCORE      = 1_000_000;
const MAX_NAME_LEN   = 30;
const MAX_HERO_LEN   = 60;
const MAX_TAG_LEN    = 16;
const DEFAULT_LIMIT  = 50;
const MAX_LIMIT      = 200;
const RANKING_CAP    = 1000;   // 各 (version, regulation) の保持上限

// ============================================================
// Upstash REST 経由のヘルパ (= fetch のみで叩く、 SDK 不要)
// ============================================================
const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisCmd(...args) {
  if (!REDIS_URL || !REDIS_TOKEN) {
    throw new Error("UPSTASH env vars not set (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN)");
  }
  const res = await fetch(REDIS_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${REDIS_TOKEN}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`Upstash HTTP ${res.status}`);
  const data = await res.json().catch(() => ({}));
  if (data && data.error) throw new Error(`Upstash: ${data.error}`);
  return data ? data.result : undefined;
}

// ============================================================
// Helpers
// ============================================================
function rankingKey(version, regulation) {
  const v = String(version || "_unknown").replace(/[^\w.\-]/g, "").slice(0, MAX_TAG_LEN);
  const r = String(regulation || "NORMAL").replace(/[^\w]/g, "").toUpperCase().slice(0, MAX_TAG_LEN);
  return `ranking:${v || "_unknown"}:${r || "NORMAL"}`;
}

function sanitizeName(name) {
  const s = String(name || "").trim().slice(0, MAX_NAME_LEN);
  return s || "anonymous";
}

function makeNonce() {
  return Math.random().toString(36).slice(2, 10);
}

async function parseBody(req) {
  // Vercel runtime によっては req.body が既にパース済 (object) のことがある
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body.length) {
    try { return JSON.parse(req.body); } catch (e) { return {}; }
  }
  // raw stream 読み (= text/plain で投げられた場合)
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (chunk) => { buf += chunk; });
    req.on("end", () => {
      try { resolve(buf ? JSON.parse(buf) : {}); }
      catch (e) { reject(new Error("Invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function send(res, code, body) {
  setCors(res);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.statusCode = code;
  res.end(JSON.stringify(body));
}

// ============================================================
// Handler (= Vercel default export)
// ============================================================
export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    setCors(res);
    res.statusCode = 204;
    return res.end();
  }

  try {
    if (req.method === "POST") return await handlePost(req, res);
    if (req.method === "GET")  return await handleGet(req, res);
    return send(res, 405, { ok: false, error: "Method Not Allowed" });
  } catch (e) {
    return send(res, 500, { ok: false, error: String(e?.message || e) });
  }
}

// ============================================================
// POST /api/ranking — score を 1 件追加
// ============================================================
async function handlePost(req, res) {
  let payload;
  try { payload = await parseBody(req); }
  catch (e) { return send(res, 400, { ok: false, error: "Invalid JSON body" }); }

  const score = Math.floor(Number(payload.score) || 0);
  if (!Number.isFinite(score) || score < 0 || score > MAX_SCORE) {
    return send(res, 400, { ok: false, error: "Invalid score" });
  }

  const entry = {
    playerName:    sanitizeName(payload.playerName),
    score:         score,
    level:         Math.max(0, Math.floor(Number(payload.level)      || 0)),
    kills:         Math.max(0, Math.floor(Number(payload.kills)      || 0)),
    hero:          String(payload.hero    || "").slice(0, MAX_HERO_LEN),
    faction:       String(payload.faction || "").slice(0, MAX_TAG_LEN),
    version:       String(payload.version || "").slice(0, MAX_TAG_LEN),
    elapsedSec:    Math.max(0, Math.floor(Number(payload.elapsedSec) || 0)),
    regulation:    String(payload.regulation || "NORMAL").slice(0, MAX_TAG_LEN).toUpperCase(),
    regulationMul: Number(payload.regulationMul) || 1.0,
    timestamp:     new Date().toISOString(),
    nonce:         makeNonce(),
  };

  const key    = rankingKey(entry.version, entry.regulation);
  const member = JSON.stringify(entry);
  await redisCmd("ZADD", key, String(score), member);

  // 上位 RANKING_CAP 件だけ残す (= 下位を削除)
  const size = Number(await redisCmd("ZCARD", key)) || 0;
  if (size > RANKING_CAP) {
    await redisCmd("ZREMRANGEBYRANK", key, "0", String(size - RANKING_CAP - 1));
  }

  return send(res, 200, { ok: true });
}

// ============================================================
// GET /api/ranking?limit=20&version=...&regulation=...
// ============================================================
async function handleGet(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const qs  = url.searchParams;

  const version    = qs.get("version")    || "";
  const regulation = (qs.get("regulation") || "NORMAL").toUpperCase();
  const limit      = Math.min(
    Math.max(1, Math.floor(Number(qs.get("limit")) || DEFAULT_LIMIT)),
    MAX_LIMIT
  );

  let keys;
  if (version) {
    keys = [rankingKey(version, regulation)];
  } else {
    // 全 version 横断: SCAN MATCH で列挙
    const scan = await redisCmd("SCAN", "0", "MATCH", `ranking:*:${regulation}`, "COUNT", "100");
    keys = Array.isArray(scan) ? (scan[1] || []) : [];
  }

  const collected = [];
  for (const key of keys) {
    const raw = await redisCmd("ZREVRANGE", key, "0", String(limit - 1));
    if (!Array.isArray(raw)) continue;
    for (const member of raw) {
      try {
        const entry = JSON.parse(member);
        delete entry.nonce;   // クライアントに露出しない
        collected.push(entry);
      } catch (e) { /* skip malformed */ }
    }
  }
  collected.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
  const ranking = collected.slice(0, limit);

  return send(res, 200, { ok: true, ranking });
}

// ============================================================
// (任意) Rate limit 雛形 — 利用する場合は handlePost の先頭で await rateLimit(req)
// ============================================================
//
// const RATE_LIMIT_WINDOW_SEC = 60;
// const RATE_LIMIT_MAX        = 30;
//
// async function rateLimit(req) {
//   const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "anon";
//   const key = `rate:${ip}`;
//   const n   = Number(await redisCmd("INCR", key)) || 0;
//   if (n === 1) await redisCmd("EXPIRE", key, String(RATE_LIMIT_WINDOW_SEC));
//   if (n > RATE_LIMIT_MAX) {
//     const err = new Error(`Rate limit exceeded (${RATE_LIMIT_MAX} / ${RATE_LIMIT_WINDOW_SEC}s)`);
//     err.statusCode = 429;
//     throw err;
//   }
// }
//
// ============================================================
// (任意) Admin endpoint 雛形 — POST /api/ranking?action=clear&adminKey=<secret>
// ============================================================
//
// const ADMIN_KEY = process.env.RANKING_ADMIN_KEY;
//
// async function handleAdmin(req, res, action) {
//   if (!ADMIN_KEY || req.query.adminKey !== ADMIN_KEY) {
//     return send(res, 403, { ok: false, error: "Forbidden" });
//   }
//   if (action === "clear") {
//     const version    = req.query.version    || "";
//     const regulation = (req.query.regulation || "NORMAL").toUpperCase();
//     if (version) await redisCmd("DEL", rankingKey(version, regulation));
//     return send(res, 200, { ok: true });
//   }
//   return send(res, 400, { ok: false, error: "Unknown action" });
// }
