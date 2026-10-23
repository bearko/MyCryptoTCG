// ============================================================
// constants.js — 共通定数 / アセット URL ヘルパ
// ============================================================
// 画像・音声はこのリポジトリに置かず、 MCH のマスター DB（bearko/mycryptoheroes）の
// raw URL を参照する（開発憲章 §9）。

export const ASSET_BASE = "https://raw.githubusercontent.com/bearko/mycryptoheroes/main/";

/** 画像 URL。 relPath は "Image/Heroes/1001.png" のような MCH リポジトリ内のパス */
export function img(relPath) {
  return ASSET_BASE + relPath;
}

/** 音声 URL。 relPath は "Audio/BGM/land.mp3" など */
export function audioUrl(relPath) {
  return ASSET_BASE + relPath;
}

export const HERO_IMG = (id) => img(`Image/Heroes/${id}.png`);
export const ENEMY_IMG = (file) => img(`Image/Enemies/${file}`);
export const EXT_IMG = (id) => img(`Image/Extensions/${id}.png`);

// ============================================================
// localStorage キー（prefix を統一）
// ============================================================
export const LS_PREFIX = "mcw";
export const LS_SAVE = `${LS_PREFIX}.save`;
export const LS_SETTINGS = `${LS_PREFIX}.settings`;

// ============================================================
// ゲームの定数（仕様 SPEC-109）
// ============================================================
export const SEASON_DAYS = 28;
export const MAP_W = 48;
export const MAP_H = 28;

export const APP_VERSION = "0.1.0";
