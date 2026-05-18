// ============================================================
// constants.js — 共通定数 / アセット URL ヘルパ
// ============================================================

// ⚠ プロジェクトごとに上書きすること
export const ASSET_BASE = "https://raw.githubusercontent.com/<user>/<asset-repo>/main/";

// 同リポジトリ assets/ で済ませる場合:
// export const ASSET_BASE = "./assets/";

/**
 * 画像 URL を組み立てる
 * @param {string} relPath - "Image/Heroes/1.png" 等
 * @returns {string}
 */
export function img(relPath) {
  return ASSET_BASE + relPath;
}

/**
 * 音声 URL を組み立てる
 * @param {string} relPath - "Audio/se_click.mp3" 等
 * @returns {string}
 */
export function audioUrl(relPath) {
  return ASSET_BASE + relPath;
}

// ============================================================
// 時間制御
// ============================================================
export const TICK_INTERVAL_MS = 1000;
export const SECONDS_PER_WEEK = 7;
export const WEEKS_PER_MONTH = 4;
export const MONTHS_PER_YEAR = 12;

// ============================================================
// localStorage キー (= prefix を統一)
// ============================================================
export const LS_PREFIX = "<prefix>";   // ⚠ プロジェクトごとに置換
export const LS_LANG = `${LS_PREFIX}.lang`;
export const LS_PLAYER_NAME = `${LS_PREFIX}.playerName`;
export const LS_RANKING_API_URL = `${LS_PREFIX}.rankingApiUrl`;
export const LS_SAVE = `${LS_PREFIX}.save.v1`;

// ============================================================
// バージョン (= ranking version filter に使う)
// ============================================================
export const APP_VERSION = "0.1.0";

// ============================================================
// デバッグフラグ
// ============================================================
export const DEBUG_PAUSE = false;       // pauseTime / resumeTime ログ
export const DEBUG_TICK = false;        // onTick ログ
