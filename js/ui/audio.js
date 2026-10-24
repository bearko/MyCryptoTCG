// audio.js — BGM / SE（SPEC-111 §10。既定 OFF）
//
// 設定は localStorage の "mcw.settings"（{ sound: boolean, reduceMotion: boolean, ... }）。
// 鳴らしても鳴らさなくてもゲームの結果は変わらない。自動では鳴らさない（設定で ON にしたときだけ）。
// 設定の読み書き（getSetting / setSetting）もここに置く（h.js の「動きを減らす」もここを読む）。

import { audioUrl, LS_SETTINGS } from '../constants.js';

const BGM = {
  land: 'Audio/BGM/land.mp3',
  battle: 'Audio/BGM/land-battle.mp3',
};

// SE は控えめに（音量も小さく、同じものは間をあける）
// SPEC-112 §1: タップ・開く・閉じる・確定・攻撃・陥落に MCH の SE を割り当てる（[パス, 音量]）
const SE = {
  tap: ['Audio/SE/Battle/4_buff.mp3', 0.12],
  open: ['Audio/SE/Actions/open_treasure.mp3', 0.22],
  close: ['Audio/SE/Actions/insp.mp3', 0.14],
  confirm: ['Audio/SE/Actions/production.mp3', 0.25],
  attack: ['Audio/SE/Battle/1_single_damage.mp3', 0.3],
  fall: ['Audio/SE/Jingles/win.mp3', 0.3],
  // 以前からの名前（各班が使っている）
  hit: ['Audio/SE/Battle/1_single_damage.mp3', 0.3],
  build: ['Audio/SE/Actions/production.mp3', 0.3],
  fort: ['Audio/SE/Jingles/win.mp3', 0.3],
  win: ['Audio/SE/Jingles/win.mp3', 0.3],
  lose: ['Audio/SE/Jingles/lose.mp3', 0.3],
};

const BGM_VOLUME = 0.35;
const SE_GAP_MS = 250;

let settings = null;
let bgmEl = null;
let bgmName = null;
let bgmLoaded = null;
const lastSe = {};

function readSettings() {
  if (settings) return settings;
  settings = { sound: false };
  try {
    const raw = localStorage.getItem(LS_SETTINGS);
    if (raw) {
      const s = JSON.parse(raw);
      if (s && typeof s === 'object') settings = { ...settings, ...s, sound: s.sound === true };
    }
  } catch {
    /* 読めなければ既定（OFF） */
  }
  return settings;
}

function writeSettings() {
  try {
    localStorage.setItem(LS_SETTINGS, JSON.stringify(settings));
  } catch {
    /* 保存できなくても動く */
  }
}

export function getSettings() {
  return { ...readSettings() };
}

/** 設定の 1 項目（無ければ def） */
export function getSetting(key, def = undefined) {
  const s = readSettings();
  return key in s ? s[key] : def;
}

/** 設定の 1 項目を保存する（sound は setSound を使う） */
export function setSetting(key, value) {
  readSettings();
  settings[key] = value;
  writeSettings();
}

export function isSoundOn() {
  return readSettings().sound === true;
}

/** 音の ON / OFF。ON にしたら（ユーザーの操作の中なので）今の BGM を鳴らし始める */
export function setSound(on) {
  readSettings();
  settings.sound = !!on;
  writeSettings();
  if (settings.sound) {
    if (bgmName) startBgm(bgmName);
  } else if (bgmEl) {
    bgmEl.pause();
  }
}

function startBgm(name) {
  const src = BGM[name];
  if (!src) return;
  try {
    if (!bgmEl) {
      bgmEl = new Audio();
      bgmEl.loop = true;
      bgmEl.volume = BGM_VOLUME;
    }
    const url = audioUrl(src);
    if (bgmLoaded !== name) {
      bgmEl.src = url;
      bgmLoaded = name;
    }
    const p = bgmEl.play();
    if (p && p.catch) p.catch(() => {});
  } catch {
    /* 鳴らせなくても何もしない */
  }
}

/** BGM を切り替える（"land" | "battle" | null）。OFF のときは名前だけ覚える */
export function playBgm(name) {
  bgmName = name;
  if (!name) {
    if (bgmEl) bgmEl.pause();
    return;
  }
  if (!isSoundOn()) return;
  startBgm(name);
}

/** SE を 1 回鳴らす（"tap" | "open" | "close" | "confirm" | "attack" | "fall" | "hit" | "build" | "fort" | "win" | "lose"） */
export function playSe(name) {
  if (!isSoundOn()) return;
  const se = SE[name];
  if (!se) return;
  const [src, vol] = se;
  const now = performance.now();
  if (lastSe[name] && now - lastSe[name] < SE_GAP_MS) return;
  lastSe[name] = now;
  try {
    const a = new Audio(audioUrl(src));
    a.volume = vol;
    const p = a.play();
    if (p && p.catch) p.catch(() => {});
  } catch {
    /* 何もしない */
  }
}
