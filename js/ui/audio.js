// audio.js — BGM / SE（SPEC-111 §10。既定 OFF）
//
// 設定は localStorage の "mcw.settings"（{ sound: boolean }）。
// 鳴らしても鳴らさなくてもゲームの結果は変わらない。自動では鳴らさない（設定で ON にしたときだけ）。

import { audioUrl, LS_SETTINGS } from '../constants.js';

const BGM = {
  land: 'Audio/BGM/land.mp3',
  battle: 'Audio/BGM/land-battle.mp3',
};

// SE は控えめに（音量も小さく、同じものは間をあける）
const SE = {
  hit: 'Audio/SE/Battle/1_single_damage.mp3',
  build: 'Audio/SE/Actions/production.mp3',
  fort: 'Audio/SE/Jingles/win.mp3',
  win: 'Audio/SE/Jingles/win.mp3',
  lose: 'Audio/SE/Jingles/lose.mp3',
  tap: 'Audio/SE/Battle/4_buff.mp3',
};

const BGM_VOLUME = 0.35;
const SE_VOLUME = 0.3;
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

/** SE を 1 回鳴らす（"hit" | "build" | "fort" | "win" | "lose" | "tap"） */
export function playSe(name) {
  if (!isSoundOn()) return;
  const src = SE[name];
  if (!src) return;
  const now = performance.now();
  if (lastSe[name] && now - lastSe[name] < SE_GAP_MS) return;
  lastSe[name] = now;
  try {
    const a = new Audio(audioUrl(src));
    a.volume = SE_VOLUME;
    const p = a.play();
    if (p && p.catch) p.catch(() => {});
  } catch {
    /* 何もしない */
  }
}
