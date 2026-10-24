// map-view.js — MCH Map（ヘックスマップ。SPEC-111 §3・§8、手触りは SPEC-112 §3。スタイルは css/map.css）
//
// canvas に描く。描く順（下から）: 地形（彩度を落とす）→ 占領色と自ランドの縁取り → 霧（等高線の模様）→ 施設 → 砦 →
// 本拠地 → 到達範囲 → 経路・攻撃の照準 → 部隊（揺れ・選択の光の輪）→ タップの波紋 → 浮く文字。
// 色の優先度（SPEC-112 D）: 地形は沈め、部隊・砦・経路は彩度を上げて手前に見せる。
// 東西ループ: カメラの見えている範囲の列を、折り返さない列番号で並べて描く（左右に最大 2 周ぶん）。
// 操作: ドラッグでパン、ホイール / ピンチでズーム、タップ（6px 未満の動き）でタイルを選ぶ。
//
// 描画は requestAnimationFrame の 1 本だけ。何かが動いている間は毎フレーム、待機中（部隊の揺れだけ）は 30fps に落とす。
// 動きを減らす（OS / 設定）ときは、揺れ・波紋・線が伸びる・カメラの寄りを止め、変化したときだけ 1 枚描く。
//
// ゲームのルールはここに書かない。経路・到達範囲・指示の可否・射程・攻撃対象はエンジンに聞く
// （pathfind.findPath / reachable / stepCost、orders.validate / queue / apMax、turn.targetAt、heroes.rangeOf）。
//
// ビューの約束（js/main.js の先頭）: render / mount / unmount / onEvent / onExecuteEnd。

import { h, clear, on, toast, band, reducedMotion, landAssetPath } from './h.js';
import * as fx from './fx.js';
import { getSetting, setSetting } from './audio.js';
import { img } from '../constants.js';
import { uiText, say } from '../engine/lines.js';
import { toPixel, fromPixel, wrapC } from '../engine/hex.js';
import { findPath, reachable, stepCost } from '../engine/pathfind.js';
import { queue, validate, apMax, projectedTile } from '../engine/orders.js';
import { rangeOf } from '../engine/heroes.js';
import { targetAt, noticesFrom, isShielded } from '../engine/turn.js';
import { terrainYield } from '../engine/economy.js';
import { save } from '../state.js';
import { endTurn, go, STEP_MS } from '../main.js';
import { orderStatus } from './phone.js';

/** zoom 1 の 1 ヘックスの大きさ（main.js の HEX_SIZE と同じ。mapCam はこの基準のワールド座標） */
const BASE = 28;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.5;
/** 部隊を選んだときに寄るズーム（これより引いていれば寄る） */
const ZOOM_FOCUS = 1.35;
/** これ以上動いたらタップではなくドラッグ */
const TAP_SLOP = 6;
const SQRT3 = Math.sqrt(3);
const ENEMY = 'enemy';
/** 待機中（揺れだけ）の描画間隔。30fps */
const IDLE_MS = 33;
/** 経路の線が伸びる速さ（1 マスあたり）と上限（SPEC-112 §3。カメラが寄りきってから伸ばす） */
const PATH_STEP_MS = 60;
const PATH_MAX_MS = 500;
/** 経路を引いたときにカメラが寄る時間（--t-page 600ms の前半） */
const ROUTE_CAM_MS = 300;
/** 実行フェーズ: 戦闘の 1 拍ごとにカメラが攻撃側と守備側の中点へ寄る時間 */
const BATTLE_CAM_MS = 400;
/** 実行フェーズ: スキル名の帯を出しておく時間（そのあと数字が弾む） */
const SKILL_LABEL_MS = 600;
/** 実行フェーズ: ダメージの数字が読めるまでの時間（そのあと砦の旗の色が変わる） */
const HIT_READ_MS = 900;
/** 実行フェーズ: 砦の旗の色が変わる演出（そのあとカットイン） */
const FLAG_MS = 300;
/** 浮く文字を画面の端からこれだけ内側に収める */
const FLOAT_MARGIN = 24;
/** これより画面の外にある浮く文字は出さない（寄せるのは半分切れる程度のものだけ） */
const NEAR = 90;
/** タップの波紋 */
const TAP_MS = 480;
/** 初回の案内を見たかどうか（mcw.settings のキー） */
const GUIDE_KEY = 'mapGuideDone';

const FORT_COLOR = { rare: '#5ab4c4', epic: '#bb86fc', legendary: '#c4a35a' };
const ENEMY_COLOR = '#ff5a5a';
const ACCENT = '#e2bd62';
const ACCENT_HI = '#ffe3a0';
const LATER = '#b5a8e0';
const INK = '#121018';
const BG = [18, 16, 24];

// pointy-top の頂点（単位ヘックス）。辺 i は頂点 i → i+1（0: 東 1: 南東 2: 南西 3: 西 4: 北西 5: 北東）
const HX = [];
const HY = [];
for (let i = 0; i < 6; i++) {
  const a = (Math.PI / 180) * (60 * i - 30);
  HX.push(Math.cos(a));
  HY.push(Math.sin(a));
}
// 辺 i の向こうの隣（odd-r。奇数行は右へ半分ずれる。engine/hex.js の toPixel と同じ並び）
const NB_EVEN = [[1, 0], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1]];
const NB_ODD = [[1, 0], [1, 1], [0, 1], [-1, 0], [0, -1], [1, -1]];

// ナビゲーター（マインちゃん）の差分。話している間は口を動かし、話し終えたら指さし
const NAVI = {
  point: 'Image/Characters/navi_ain_00_pointer_up.png',
  talk: ['Image/Characters/navi_ain_speak_00_talk.png', 'Image/Characters/navi_ain_speak_01_talk.png'],
  smile: 'Image/Characters/navi_ain_06_smile.png',
};

/** マウントしている間だけの状態（canvas・入力・演出） */
let V = null;

/** 画像のキャッシュ（相対パス → { im, ok, bad }）。読み込み前・失敗は null を返し、色だけで描く */
const IMAGES = new Map();

function getImage(rel) {
  if (!rel || typeof Image === 'undefined') return null;
  let e = IMAGES.get(rel);
  if (!e) {
    const im = new Image();
    im.decoding = 'async';
    e = { im, ok: false, bad: false };
    im.onload = () => { e.ok = true; requestDraw(); };
    im.onerror = () => { e.bad = true; };
    im.src = img(rel);
    IMAGES.set(rel, e);
  }
  return e.ok ? e.im : null;
}

const t = (app, key) => uiText(app.db, key);
/** 文言（messages.json に無ければ fallback） */
function tx(app, key, fallback) {
  const s = uiText(app.db, key);
  return s === key ? fallback : s;
}

/** Map だけの画面の状態（app.ui.mapView） */
function mv(app) {
  if (!app.ui.mapView) {
    let debug = false;
    try { debug = new URLSearchParams(location.search).get('debug') === '1'; } catch { debug = false; }
    app.ui.mapView = { plan: null, debug, show: { yield: false, owner: false, fog: false }, menu: false, focusedSquad: null };
  }
  return app.ui.mapView;
}

const motion = () => !reducedMotion();

// ------------------------------------------------------------
// 参照の小物
// ------------------------------------------------------------

function heroOf(db, squad) {
  return squad ? (db.heroes[squad.heroId] || db.heroes[String(squad.heroId)] || null) : null;
}

function landDef(db, id) {
  return (db.lands || []).find((l) => l.id === id) || null;
}

function landName(app, id) {
  if (id === ENEMY) return t(app, 'map.enemyLand');
  const d = landDef(app.db, id);
  return d ? (d.nameJa || d.name) : (id || t(app, 'map.noOwner'));
}

function landColor(db, id) {
  if (id === ENEMY) return ENEMY_COLOR;
  const d = landDef(db, id);
  return d ? d.color : '#8c7fb0';
}

function enemyOf(db, id) {
  return (db.enemies || []).find((e) => e.id === id) || null;
}

let exploredCache = { ref: null, len: -1, set: new Set() };

function exploredSet(st) {
  const land = st.lands[st.playerLand];
  const arr = (land && land.explored) || [];
  if (exploredCache.ref !== arr || exploredCache.len !== arr.length) {
    exploredCache = { ref: arr, len: arr.length, set: new Set(arr) };
  }
  return exploredCache.set;
}

function isVisible(app, tile) {
  if (mv(app).show.fog) return true;
  return exploredSet(app.state).has(tile);
}

/** 選択中の自分の部隊（無ければ null） */
function selectedSquad(app) {
  const st = app.state;
  const id = app.ui.selectedSquad;
  const sq = id != null ? st.squads[id] : null;
  return sq && sq.land === st.playerLand ? sq : null;
}

function squadsAt(st, tile) {
  const out = [];
  for (const s of Object.values(st.squads || {})) if (s.tile === tile) out.push(s);
  return out;
}

function mySquads(st) {
  return Object.values(st.squads || {}).filter((s) => s.land === st.playerLand);
}

/** 指示を待っている自分の部隊（敗走していない・AP が残っている・何も積んでいない）。表示のための数え方 */
function idleSquads(st) {
  return mySquads(st).filter((s) => s.status !== 'routed' && (s.ap || 0) > 0 && !(s.orders || []).length);
}

/** ロスターの順（phone.js・Chat と同じ: id の数の順） */
function rosterSquads(st) {
  return mySquads(st).sort((a, b) => String(a.id).localeCompare(String(b.id), 'en', { numeric: true }));
}

/** まだ指示を出せるか（未指示 / 指示中 で、AP が残っている。ステータスは phone.js の orderStatus） */
function canAct(app, sq) {
  if (!sq || sq.status === 'routed' || (sq.ap || 0) <= 0) return false;
  const k = orderStatus(app, sq);
  return k === 'none' || k === 'doing';
}

/** ロスターの順で、afterId の次から数えて最初の「まだ指示を出せる」部隊（afterId 自身は除く） */
function nextActive(app, afterId = null) {
  const list = rosterSquads(app.state);
  const n = list.length;
  const i = afterId == null ? -1 : list.findIndex((s) => s.id === afterId);
  for (let k = 1; k <= n; k++) {
    const s = list[(i + k + n) % n];
    if (s.id !== afterId && canAct(app, s)) return s;
  }
  return null;
}

function homeAt(st, tile) {
  for (const [id, l] of Object.entries(st.lands || {})) {
    if (id !== ENEMY && l && l.home === tile) return { id, land: l };
  }
  return null;
}

function targetName(app, target) {
  if (!target) return '';
  if (target.home) return `${landName(app, target.home)}${t(app, 'map.home')}`;
  if (typeof target.rank === 'string') return target.name || t(app, `fort.${target.rank}`);
  const hero = heroOf(app.db, target);
  return hero ? hero.name : '';
}

function tileTitle(app, tile) {
  const st = app.state;
  const tl = st.map.tiles[tile];
  if (!tl) return '';
  if (isVisible(app, tile)) {
    const home = homeAt(st, tile);
    if (home) return `${landName(app, home.id)}${t(app, 'map.home')}`;
    if (tl.fort && st.forts[tl.fort]) return st.forts[tl.fort].name || t(app, 'map.fort');
  }
  const terr = app.db.terrain[tl.terrain];
  return terr ? terr.name : tl.terrain;
}

function fmt(text, vars) {
  return String(text).replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? m : String(vars[k])));
}

function hashId(id) {
  let n = 0;
  for (const ch of String(id)) n = (n * 31 + ch.charCodeAt(0)) | 0;
  return (n >>> 0) / 4294967295;
}

// ------------------------------------------------------------
// 色（SPEC-112 D: 地形は沈め、部隊・砦・経路を立てる）
// ------------------------------------------------------------

function rgbOf(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return [140, 127, 176];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function alpha(hex, a) {
  const [r, g, b] = rgbOf(hex);
  return `rgba(${r},${g},${b},${a})`;
}

const MUTED = new Map();
/** 地形の色: 彩度を 34% 落とし、背景の色へ 20% 寄せる */
function muted(hex) {
  let v = MUTED.get(hex);
  if (!v) {
    const [r, g, b] = rgbOf(hex);
    const l = 0.3 * r + 0.59 * g + 0.11 * b;
    const m = (c, i) => Math.round((c + (l - c) * 0.34) * 0.8 + BG[i] * 0.2);
    v = `rgb(${m(r, 0)},${m(g, 1)},${m(b, 2)})`;
    MUTED.set(hex, v);
  }
  return v;
}

/** 霧の模様（薄い等高線）。ワールドに貼り付けてカメラと一緒に動かす */
let FOG_TILE = null;
function fogTile() {
  if (FOG_TILE || typeof document === 'undefined') return FOG_TILE;
  const c = document.createElement('canvas');
  const N = 160;
  c.width = c.height = N;
  const g = c.getContext('2d');
  g.strokeStyle = 'rgba(150,138,196,.09)';
  g.lineWidth = 1;
  // 端でつながる波線（周期 N）を、少しずつ位相をずらして重ねる
  for (let k = 0; k < 7; k++) {
    const y0 = (k + 0.5) * (N / 7);
    const amp = 5 + (k % 3) * 2.5;
    const ph = k * 1.7;
    g.beginPath();
    for (let x = 0; x <= N; x += 4) {
      const y = y0 + Math.sin((x / N) * Math.PI * 2 + ph) * amp + Math.sin((x / N) * Math.PI * 4 + ph * 2) * amp * 0.35;
      if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
  }
  FOG_TILE = c;
  return c;
}

// ------------------------------------------------------------
// カメラ
// ------------------------------------------------------------

function period(st) {
  return BASE * SQRT3 * st.map.w;
}

function clampCam(app) {
  const cam = app.ui.mapCam;
  const st = app.state;
  cam.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, cam.zoom || 1));
  const P = period(st);
  cam.x = ((cam.x % P) + P) % P;
  const maxY = BASE * 1.5 * (st.map.h - 1);
  cam.y = Math.min(maxY, Math.max(0, cam.y));
}

function tileWorld(st, tile) {
  const w = st.map.w;
  return toPixel(tile % w, Math.floor(tile / w), BASE);
}

/** ワールド座標 → 画面（東西ループは、カメラにいちばん近い写しを使う） */
function toScreen(app, wx, wy) {
  const cam = app.ui.mapCam;
  const P = period(app.state);
  let dx = wx - cam.x;
  dx = ((dx % P) + P * 1.5) % P - P / 2;
  return { x: V.cw / 2 + dx * cam.zoom, y: V.ch / 2 + (wy - cam.y) * cam.zoom };
}

/** タイルの中心の clientX / clientY（スプライトを重ねる用） */
function tileClient(app, tile) {
  const p = tileWorld(app.state, tile);
  const s = toScreen(app, p.x, p.y);
  const r = V.canvas.getBoundingClientRect();
  const inside = s.x > -20 && s.x < V.cw + 20 && s.y > -20 && s.y < V.ch + 20;
  return inside ? { x: r.left + s.x, y: r.top + s.y } : null;
}

function screenToWorld(app, sx, sy) {
  const cam = app.ui.mapCam;
  return { x: cam.x + (sx - V.cw / 2) / cam.zoom, y: cam.y + (sy - V.ch / 2) / cam.zoom };
}

function screenToTile(app, sx, sy) {
  const st = app.state;
  const p = screenToWorld(app, sx, sy);
  const { c, r } = fromPixel(p.x, p.y, BASE);
  if (r < 0 || r >= st.map.h) return null;
  return r * st.map.w + wrapC(c, st.map.w);
}

function zoomAround(app, sx, sy, zoom) {
  const cam = app.ui.mapCam;
  const before = screenToWorld(app, sx, sy);
  cam.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
  cam.x = before.x - (sx - V.cw / 2) / cam.zoom;
  cam.y = before.y - (sy - V.ch / 2) / cam.zoom;
  clampCam(app);
  requestDraw();
}

function centerOn(app, tile) {
  const p = tileWorld(app.state, tile);
  app.ui.mapCam.x = p.x;
  app.ui.mapCam.y = p.y;
  clampCam(app);
}

/**
 * カメラをなめらかにタイルへ寄せる（SPEC-112 §3。--t-page）。動きを減らすときはすぐ移る。
 * offsetY は画面の中心からのずらし（シートが下にあるときに上へ寄せる）
 */
function flyTo(app, tile, { zoom = null, dur = null, offsetY = 0 } = {}) {
  if (!V || tile == null) return;
  const cam = app.ui.mapCam;
  const st = app.state;
  const p = tileWorld(st, tile);
  const tz = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom || cam.zoom));
  const P = period(st);
  let dx = p.x - cam.x;
  dx = ((dx % P) + P * 1.5) % P - P / 2;
  const ty = p.y + offsetY / tz;
  if (!motion()) {
    cam.x += dx;
    cam.y = ty;
    cam.zoom = tz;
    clampCam(app);
    requestDraw();
    return;
  }
  V.camAnim = { fx: cam.x, fy: cam.y, fz: cam.zoom, tx: cam.x + dx, ty, tz, t0: now(), dur: dur ?? fx.token('--t-page', 600) };
  requestDraw();
}

/** 上の札・下のロスター / シート・案内に隠れていない、地図の見えている帯（画面座標） */
function viewBand() {
  const top = V.topEl ? Math.max(56, V.topEl.offsetTop + V.topEl.offsetHeight + 4) : 64;
  const ui = bottomUi();
  const ge = V.guide && V.guide.el && !V.guide.el.classList.contains('is-out') ? V.guide.el.offsetHeight + 8 : 0;
  return { top, bottom: Math.max(top + 40, V.ch - ui - ge - 12) };
}

/** 画面の下に重なっている UI（シートが開いていればシート、無ければロスターの帯）の高さ */
function bottomUi() {
  if (!V) return 0;
  if (V.sheet && !V.sheet.hidden) return V.sheet.getBoundingClientRect().height;
  if (V.dock && !V.dock.hidden) return V.dock.offsetHeight;
  return 0;
}

/**
 * タイルが画面の端やシートに隠れていれば寄せる。from を渡すと、出発地と行き先の両方が収まるように寄せる
 * （収まらなければ行き先を優先）。寄せたら true（動きを減らすときは寄せても false。待つ必要が無いため）
 */
function ensureVisible(app, tile, from = null, dur = fx.token('--t-flip', 380)) {
  if (!V || tile == null) return false;
  const st = app.state;
  const p = tileWorld(st, tile);
  const s = toScreen(app, p.x, p.y);
  const m = BASE * app.ui.mapCam.zoom;
  const b = viewBand();
  const inside = (q) => q.x >= m && q.x <= V.cw - m && q.y >= b.top + m * 0.5 && q.y <= b.bottom - m * 0.5;
  let q = null;
  if (from != null && from !== tile) {
    const f = tileWorld(st, from);
    const P = period(st);
    let dx = f.x - p.x;
    dx = ((dx % P) + P * 1.5) % P - P / 2;
    q = { x: s.x + dx * app.ui.mapCam.zoom, y: s.y + (f.y - p.y) * app.ui.mapCam.zoom };
  }
  if (inside(s) && (!q || inside(q))) return false;
  const mid = (b.top + b.bottom) / 2;
  if (q && Math.abs(q.x - s.x) < V.cw - m * 2 && Math.abs(q.y - s.y) < b.bottom - b.top - m) {
    // 2 点の真ん中へ（ワールド座標で）
    const wx = (q.x + s.x) / 2;
    const wy = (q.y + s.y) / 2;
    const w = screenToWorld(app, wx, wy);
    const cam = app.ui.mapCam;
    if (!motion()) { cam.x = w.x; cam.y = w.y + (V.ch / 2 - mid) / cam.zoom; clampCam(app); requestDraw(); return false; }
    V.camAnim = { fx: cam.x, fy: cam.y, fz: cam.zoom, tx: w.x, ty: w.y + (V.ch / 2 - mid) / cam.zoom, tz: cam.zoom, t0: now(), dur };
    requestDraw();
    return true;
  }
  flyTo(app, tile, { offsetY: V.ch / 2 - mid, dur });
  return motion();
}

// ------------------------------------------------------------
// 描画のループ
// ------------------------------------------------------------

function now() {
  return (typeof performance !== 'undefined' ? performance.now() : 0);
}

function requestDraw() {
  if (!V) return;
  V.dirty = true;
  V.staticDirty = true;
  if (V.raf) return;
  V.raf = requestAnimationFrame(frame);
}

/** 毎フレーム描く必要があるか（何かが動いている） */
function busy(tm) {
  return !!(V.camAnim || V.anims.size || V.floats.length || V.lunges.size || V.taps.length || V.shake
    || (V.pathFx && tm - V.pathFx.t0 < V.pathFx.dur + 500)
    || V.flagFx.length || V.holds.size
    || (V.selFx && tm - V.selFx.t0 < 700));
}

/** 待機中も揺らし続けるか（動きを減らさない・タブが見えている） */
function alive() {
  return motion() && !(typeof document !== 'undefined' && document.hidden);
}

function frame() {
  if (!V) return;
  V.raf = 0;
  const tm = now();
  const active = busy(tm);
  const live = alive();
  if (!active && !V.dirty && live && tm - V.lastDraw < IDLE_MS) {
    V.raf = requestAnimationFrame(frame);
    return;
  }
  // カメラの寄り
  if (V.camAnim) {
    const a = V.camAnim;
    const k = Math.min(1, (tm - a.t0) / a.dur);
    const e = 1 - Math.pow(1 - k, 3);
    const cam = V.app.ui.mapCam;
    cam.x = a.fx + (a.tx - a.fx) * e;
    cam.y = a.fy + (a.ty - a.fy) * e;
    cam.zoom = a.fz + (a.tz - a.fz) * e;
    if (k >= 1) V.camAnim = null;
    clampCam(V.app);
  }
  for (const [id, a] of V.anims) if (tm - a.t0 >= a.dur) V.anims.delete(id);
  for (const [id, a] of V.lunges) if (tm - a.t0 >= a.dur) V.lunges.delete(id);
  V.floats = V.floats.filter((f) => tm - f.t0 < f.dur);
  V.taps = V.taps.filter((f) => tm - f.t0 < TAP_MS);
  V.flagFx = V.flagFx.filter((f) => tm - f.t0 < f.dur);
  if (V.shake && tm - V.shake.t0 >= V.shake.dur) V.shake = null;
  V.dirty = false;
  V.lastDraw = tm;
  draw(V.app, tm);
  if (active || live || V.dirty) V.raf = requestAnimationFrame(frame);
}

// ------------------------------------------------------------
// 描画
// ------------------------------------------------------------

function hexPath(ctx, x, y, s) {
  ctx.beginPath();
  ctx.moveTo(x + HX[0] * s, y + HY[0] * s);
  for (let i = 1; i < 6; i++) ctx.lineTo(x + HX[i] * s, y + HY[i] * s);
  ctx.closePath();
}

function hexInto(path, x, y, s) {
  path.moveTo(x + HX[0] * s, y + HY[0] * s);
  for (let i = 1; i < 6; i++) path.lineTo(x + HX[i] * s, y + HY[i] * s);
  path.closePath();
}

function roundRect(ctx, x, y, w, hh, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + hh, r);
  ctx.arcTo(x + w, y + hh, x, y + hh, r);
  ctx.arcTo(x, y + hh, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function bar(ctx, x, y, w, hh, ratio, color) {
  ctx.fillStyle = 'rgba(10,9,16,.88)';
  roundRect(ctx, x - 1, y - 1, w + 2, hh + 2, (hh + 2) / 2);
  ctx.fill();
  const rw = Math.max(0, Math.min(1, ratio)) * w;
  if (rw > 0) {
    ctx.fillStyle = color;
    roundRect(ctx, x, y, Math.max(hh, rw), hh, hh / 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.35)';
    ctx.fillRect(x + hh / 2, y, Math.max(0, rw - hh), Math.max(1, hh * 0.3));
  }
}

function nbTile(st, c, r, i) {
  const d = (r & 1 ? NB_ODD : NB_EVEN)[i];
  const rr = r + d[1];
  if (rr < 0 || rr >= st.map.h) return -1;
  return rr * st.map.w + wrapC(c + d[0], st.map.w);
}

/** test が真のセルの外周（隣が偽の辺）だけを 1 本のパスにして返す */
function edgePath(app, cells, test, s) {
  const st = app.state;
  const p = new Path2D();
  let any = false;
  for (const c of cells) {
    if (!test(c.tile)) continue;
    for (let i = 0; i < 6; i++) {
      const nb = nbTile(st, c.c, c.r, i);
      if (nb >= 0 && test(nb)) continue;
      const j = (i + 1) % 6;
      p.moveTo(c.x + HX[i] * s, c.y + HY[i] * s);
      p.lineTo(c.x + HX[j] * s, c.y + HY[j] * s);
      any = true;
    }
  }
  return any ? p : null;
}

/** 見えている範囲のセル（折り返さない列番号で 2 周ぶんまで） */
function visibleCells(app) {
  const st = app.state;
  const cam = app.ui.mapCam;
  const z = cam.zoom;
  const colW = BASE * SQRT3;
  const rowH = BASE * 1.5;
  const x0 = cam.x - V.cw / 2 / z;
  const x1 = cam.x + V.cw / 2 / z;
  const y0 = cam.y - V.ch / 2 / z;
  const y1 = cam.y + V.ch / 2 / z;
  const rMin = Math.max(0, Math.floor(y0 / rowH) - 1);
  const rMax = Math.min(st.map.h - 1, Math.ceil(y1 / rowH) + 1);
  const cMin = Math.floor(x0 / colW) - 1;
  const cMax = Math.ceil(x1 / colW) + 1;
  const out = [];
  for (let r = rMin; r <= rMax; r++) {
    for (let c = cMin; c <= cMax; c++) {
      const p = toPixel(c, r, BASE);
      out.push({
        tile: r * st.map.w + wrapC(c, st.map.w),
        c, r,
        x: V.cw / 2 + (p.x - cam.x) * z,
        y: V.ch / 2 + (p.y - cam.y) * z,
      });
    }
  }
  return out;
}

/**
 * 動かない層（地形 → 占領色・縁取り → 霧 → 施設 → 砦 → 本拠地 → 到達範囲）を、裏の canvas に描く。
 * カメラ・状態・選択が変わったときだけ描き直し、毎フレームは 1 枚貼るだけにする（スマホで 60fps を保つため）。
 */
function drawStatic(app, ctx, cells, tm) {
  const { cw, ch, dpr } = V;
  const st = app.state;
  const db = app.db;
  const ui = mv(app);
  const s = BASE * app.ui.mapCam.zoom;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#0d0b13';
  ctx.fillRect(0, 0, cw, ch);
  const tiles = st.map.tiles;
  const exp = exploredSet(st);
  const fogOff = ui.show.fog;
  const seen = (i) => fogOff || exp.has(i);
  const me = st.playerLand;

  // 1. 地形（彩度を落とす）
  for (const c of cells) {
    const terr = db.terrain[tiles[c.tile].terrain];
    hexPath(ctx, c.x, c.y, s + 0.6);
    ctx.fillStyle = terr ? muted(terr.color) : '#2a2438';
    ctx.fill();
  }
  // 地形の上辺に薄い光（触れる物の縁。ズームしているときだけ）
  if (s >= 18) {
    const hi = new Path2D();
    for (const c of cells) {
      hi.moveTo(c.x + HX[3] * (s - 1), c.y + HY[3] * (s - 1));
      hi.lineTo(c.x + HX[4] * (s - 1), c.y + HY[4] * (s - 1));
      hi.lineTo(c.x + HX[5] * (s - 1), c.y + HY[5] * (s - 1));
      hi.lineTo(c.x + HX[0] * (s - 1), c.y + HY[0] * (s - 1));
    }
    ctx.strokeStyle = 'rgba(255,255,255,.055)';
    ctx.lineWidth = 1;
    ctx.stroke(hi);
    ctx.strokeStyle = 'rgba(0,0,0,.22)';
    const lo = new Path2D();
    for (const c of cells) {
      lo.moveTo(c.x + HX[0] * s, c.y + HY[0] * s);
      lo.lineTo(c.x + HX[1] * s, c.y + HY[1] * s);
      lo.lineTo(c.x + HX[2] * s, c.y + HY[2] * s);
      lo.lineTo(c.x + HX[3] * s, c.y + HY[3] * s);
    }
    ctx.stroke(lo);
  }
  // 2. 占領色（自ランドは薄く塗って縁取りで見せる）。陥落の演出中の砦は、旗が変わるまで前の持ち主で描く
  const heldTile = new Map();
  for (const hd of V.holds.values()) if (hd.tile != null) heldTile.set(hd.tile, hd.tileOwner);
  const ownerOf = (i) => (seen(i) && tiles[i] ? (heldTile.has(i) ? heldTile.get(i) : tiles[i].owner) : null);
  for (const c of cells) {
    const owner = ownerOf(c.tile);
    if (!owner) continue;
    hexPath(ctx, c.x, c.y, s);
    ctx.fillStyle = alpha(landColor(db, owner), ui.show.owner ? 0.7 : owner === me ? 0.24 : 0.2);
    ctx.fill();
  }
  // 縁取り（土地の境目だけ。自ランドは太く、光る）
  {
    const owners = new Set();
    for (const c of cells) { const o = ownerOf(c.tile); if (o) owners.add(o); }
    for (const o of owners) {
      const p = edgePath(app, cells, (i) => ownerOf(i) === o, s - (o === me ? 1.5 : 1));
      if (!p) continue;
      const col = landColor(db, o);
      ctx.lineJoin = 'round';
      if (o === me) {
        ctx.strokeStyle = alpha(col, 0.28);
        ctx.lineWidth = Math.max(4, s * 0.22);
        ctx.stroke(p);
        ctx.strokeStyle = col;
        ctx.lineWidth = Math.max(1.5, s * 0.08);
        ctx.stroke(p);
      } else {
        ctx.strokeStyle = alpha(col, 0.75);
        ctx.lineWidth = Math.max(1, s * 0.05);
        ctx.stroke(p);
      }
    }
  }
  // 細い境界線
  if (s >= 16) {
    const grid = new Path2D();
    for (const c of cells) hexInto(grid, c.x, c.y, s);
    ctx.strokeStyle = 'rgba(0,0,0,.14)';
    ctx.lineWidth = 1;
    ctx.stroke(grid);
  }
  // 3. 霧（単色の黒ではなく、奥行きのある暗さ + 薄い等高線 + 既知の世界の縁）
  if (!fogOff) {
    const fog = new Path2D();
    let any = false;
    for (const c of cells) {
      if (exp.has(c.tile)) continue;
      hexInto(fog, c.x, c.y, s + 0.6);
      any = true;
    }
    if (any) {
      const g = ctx.createLinearGradient(0, 0, 0, ch);
      g.addColorStop(0, 'rgba(14,11,24,.9)');
      g.addColorStop(1, 'rgba(7,6,12,.92)');
      ctx.fillStyle = g;
      ctx.fill(fog);
      const tile = fogTile();
      if (tile) {
        const pat = ctx.createPattern(tile, 'repeat');
        const cam = app.ui.mapCam;
        const z = cam.zoom;
        if (pat && pat.setTransform && typeof DOMMatrix !== 'undefined') {
          pat.setTransform(new DOMMatrix([z, 0, 0, z, (cw / 2 - cam.x * z), (ch / 2 - cam.y * z)]));
        }
        if (pat) { ctx.fillStyle = pat; ctx.fill(fog); }
      }
      const edge = edgePath(app, cells, (i) => !exp.has(i), s);
      if (edge) {
        ctx.strokeStyle = 'rgba(170,158,220,.22)';
        ctx.lineWidth = 1;
        ctx.stroke(edge);
      }
    }
  }
  // 産出（デバッグ表示）
  if (ui.show.yield && s >= 14) {
    ctx.font = `700 ${Math.max(8, s * 0.32)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const c of cells) {
      const y = terrainYield(db, tiles[c.tile].terrain);
      ctx.fillStyle = INK;
      ctx.fillText(`${y.food}/${y.gum}/${y.mat}`, c.x, c.y + s * 0.5);
    }
  }
  // 4. 施設（小さな記号 + ランク）と建築中
  if (s >= 12) {
    const fs = Math.max(8, s * 0.36);
    ctx.font = `800 ${fs}px "Hiragino Sans","Noto Sans JP",sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const c of cells) {
      if (!seen(c.tile)) continue;
      const tl = tiles[c.tile];
      const build = st.builds && st.builds[c.tile];
      if (!tl.facility && !build) continue;
      const kind = tl.facility ? tl.facility.kind : build.kind;
      const fac = db.facilities[kind];
      const mark = (fac ? fac.name : kind).slice(0, 1);
      const bw = fs * 2.2;
      const bh = fs * 1.35;
      const bx = c.x - s * 0.82;
      const by = c.y - s * 0.62;
      roundRect(ctx, bx, by, bw, bh, 3);
      ctx.fillStyle = build && !tl.facility ? 'rgba(42,36,56,.8)' : 'rgba(14,12,20,.9)';
      ctx.fill();
      ctx.strokeStyle = landColor(db, tl.owner || (build && build.land));
      ctx.lineWidth = 1.2;
      if (build) {
        ctx.setLineDash([2, 2]);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
      ctx.fillStyle = '#f2ecfa';
      const rank = tl.facility ? tl.facility.rank : 0;
      ctx.fillText(rank ? `${mark}${rank}` : mark, bx + bw / 2, by + bh / 2 + 0.5);
    }
  }
  // 5. 砦（ランクの色の枠 + 光 + エネミーの絵 + 耐久）
  for (const c of cells) {
    const tl = tiles[c.tile];
    if (!tl.fort || !seen(c.tile)) continue;
    const fort = st.forts[tl.fort];
    if (!fort) continue;
    const col = FORT_COLOR[fort.rank] || ACCENT;
    hexPath(ctx, c.x, c.y, s - 2);
    ctx.fillStyle = 'rgba(8,7,12,.38)';
    ctx.fill();
    ctx.lineWidth = Math.max(5, s * 0.3);
    ctx.strokeStyle = alpha(col, 0.22);
    ctx.stroke();
    ctx.lineWidth = Math.max(2, s * 0.12);
    ctx.strokeStyle = col;
    ctx.stroke();
    const en = enemyOf(db, fort.enemyId);
    const im = en ? getImage(en.image) : null;
    const size = s * 1.25;
    if (im) ctx.drawImage(im, c.x - size / 2, c.y - size / 2 - s * 0.08, size, size);
    else {
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(c.x, c.y, s * 0.28, 0, Math.PI * 2);
      ctx.fill();
    }
    const hold = V.holds.get(fort.id);
    const owner = hold ? hold.owner : fort.owner;
    if (owner !== ENEMY) drawPennant(ctx, c.x + s * 0.5, c.y - s * 0.25, s, landColor(db, owner));
    if (s >= 12) {
      const ratio = fort.maxDurability > 0 ? fort.durability / fort.maxDurability : 0;
      bar(ctx, c.x - s * 0.6, c.y + s * 0.62, s * 1.2, Math.max(2, s * 0.1), ratio, col);
    }
  }
  // 6. 本拠地（ランドセクタのアイコン）
  for (const c of cells) {
    if (!seen(c.tile)) continue;
    const home = homeAt(st, c.tile);
    if (!home) continue;
    const def = landDef(db, home.id);
    const col = landColor(db, home.id);
    const dead = home.land.alive === false;
    hexPath(ctx, c.x, c.y, s - 1.5);
    if (!dead) {
      ctx.lineWidth = Math.max(6, s * 0.34);
      ctx.strokeStyle = alpha(col, 0.22);
      ctx.stroke();
    }
    ctx.lineWidth = Math.max(2, s * 0.14);
    ctx.strokeStyle = dead ? '#5a5248' : col;
    ctx.stroke();
    const im = def ? getImage(landAssetPath(def.icon)) : null;
    const size = s * 1.35;
    ctx.globalAlpha = dead ? 0.4 : 1;
    if (im) ctx.drawImage(im, c.x - size / 2, c.y - size / 2, size, size);
    else {
      ctx.fillStyle = col;
      roundRect(ctx, c.x - s * 0.4, c.y - s * 0.4, s * 0.8, s * 0.8, 4);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    const dur = typeof home.land.homeDurability === 'number' ? home.land.homeDurability : 100;
    if (dur < 100 && s >= 12) bar(ctx, c.x - s * 0.6, c.y + s * 0.66, s * 1.2, Math.max(2, s * 0.1), dur / 100, col);
  }

  // 7. 到達範囲（届くところは明るく縁取り、届かないところは沈める）
  const sel = !app.ui.executing ? selectedSquad(app) : null;
  if (sel) {
    const reach = reachOf(app, sel);
    const fade = V.selFx && motion() ? Math.min(1, (tm - V.selFx.t0) / 260) : 1;
    const dim = new Path2D();
    const lit = new Path2D();
    for (const c of cells) {
      if (!seen(c.tile)) continue;
      if (reach && reach.has(c.tile)) hexInto(lit, c.x, c.y, s - 1);
      else hexInto(dim, c.x, c.y, s + 0.6);
    }
    ctx.fillStyle = `rgba(0,0,0,${0.34 * fade})`;
    ctx.fill(dim);
    ctx.fillStyle = `rgba(255,236,190,${0.13 * fade})`;
    ctx.fill(lit);
    if (reach) {
      const edge = edgePath(app, cells, (i) => reach.has(i) && seen(i), s - 1);
      if (edge) {
        ctx.lineJoin = 'round';
        ctx.strokeStyle = `rgba(255,227,160,${0.65 * fade})`;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.stroke(edge);
        ctx.setLineDash([]);
        ctx.lineDashOffset = 0;
      }
    }
  }
}

/** 砦の旗（竿 + 三角の旗。持ち主のランドの色） */
function drawPennant(ctx, x, y, s, color) {
  const hgt = Math.max(9, s * 0.62);
  const fw = Math.max(7, s * 0.4);
  ctx.strokeStyle = '#f2ecfa';
  ctx.lineWidth = Math.max(1.2, s * 0.05);
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x, y - hgt);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x, y - hgt);
  ctx.lineTo(x + fw, y - hgt + fw * 0.42);
  ctx.lineTo(x, y - hgt + fw * 0.84);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1;
  ctx.stroke();
}

/** 裏の canvas を描き直すかどうかの鍵（カメラ・大きさ・選択・到達範囲・表示の切り替え） */
function staticKey(app, tm) {
  const cam = app.ui.mapCam;
  const sel = !app.ui.executing ? selectedSquad(app) : null;
  const fading = sel && V.selFx && motion() && tm - V.selFx.t0 < 260;
  const show = mv(app).show;
  return [cam.x.toFixed(2), cam.y.toFixed(2), cam.zoom.toFixed(4), V.cw, V.ch, V.dpr,
    sel ? sel.id : '', V.reach ? V.reach.key : '', fading ? tm : '', show.fog, show.owner, show.yield, V.holds.size].join('|');
}

function draw(app, tm = now()) {
  if (!V || !V.ctx || !app.state) return;
  const { ctx, dpr } = V;
  const st = app.state;
  const ui = mv(app);
  const s = BASE * app.ui.mapCam.zoom;
  const cells = visibleCells(app);
  const tiles = st.map.tiles;
  const exp = exploredSet(st);
  const seen = (i) => ui.show.fog || exp.has(i);
  const me = st.playerLand;
  const sel = !app.ui.executing ? selectedSquad(app) : null;
  if (sel) reachOf(app, sel);
  const key = staticKey(app, tm);
  if (V.staticDirty || key !== V.staticKey || !V.sctx) {
    if (!V.sctx) {
      V.sc = document.createElement('canvas');
      V.sctx = V.sc.getContext('2d');
    }
    if (V.sc.width !== V.canvas.width || V.sc.height !== V.canvas.height) {
      V.sc.width = V.canvas.width;
      V.sc.height = V.canvas.height;
    }
    drawStatic(app, V.sctx, cells, tm);
    V.staticKey = key;
    V.staticDirty = false;
  }
  // 揺れ（陥落・命中）
  let sx = 0;
  let sy = 0;
  if (V.shake && tm >= V.shake.t0) {
    const k = (tm - V.shake.t0) / V.shake.dur;
    const a = V.shake.amp * (1 - k) * (1 - k);
    sx = Math.sin(tm * 0.11) * a;
    sy = Math.cos(tm * 0.13) * a * 0.6;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = false;
  if (sx || sy) {
    ctx.fillStyle = '#0d0b13';
    ctx.fillRect(0, 0, V.canvas.width, V.canvas.height);
  }
  ctx.drawImage(V.sc, Math.round(sx * dpr), Math.round(sy * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, sx * dpr, sy * dpr);

  if (sel) {
    const here = projectedTile(sel);
    if (here !== sel.tile) {
      for (const c of cells) {
        if (c.tile !== here) continue;
        hexPath(ctx, c.x, c.y, s - 1);
        ctx.lineWidth = 2;
        ctx.strokeStyle = alpha(ACCENT, 0.8);
        ctx.stroke();
      }
    }
    drawQueued(app, sel, s, tm);
    const plan = ui.plan;
    if (plan && plan.squad === sel.id && plan.kind === 'move' && plan.path) drawPath(app, sel, plan, s, tm);
    if (plan && plan.squad === sel.id && plan.kind === 'attack') drawAim(app, sel, plan, s, tm);
  }

  // 8. 部隊（ヒーローの絵。待機中は揺れる。敵は赤い縁）
  const byTile = new Map();
  for (const sq of Object.values(st.squads || {})) {
    if (V.anims.has(sq.id)) continue;
    if (!byTile.has(sq.tile)) byTile.set(sq.tile, []);
    byTile.get(sq.tile).push(sq);
  }
  for (const c of cells) {
    const list = byTile.get(c.tile);
    if (!list || !seen(c.tile)) continue;
    drawStack(app, c, list, s, tm, !!tiles[c.tile].fort || !!homeAt(st, c.tile));
  }
  // 動いている部隊（タイル間を滑る。最後に少し弾む）
  for (const [id, a] of V.anims) {
    const sq = st.squads[id];
    if (!sq) continue;
    if (!seen(a.from) && !seen(a.to)) continue;
    const k = Math.min(1, (tm - a.t0) / a.dur);
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    const to = tileWorld(st, a.to);
    const from = tileWorld(st, a.from);
    const P = period(st);
    let dx = from.x - to.x;
    dx = ((dx % P) + P * 1.5) % P - P / 2;
    const p = toScreen(app, to.x + dx * (1 - e), from.y + (to.y - from.y) * e);
    const hop = Math.sin(Math.PI * k) * s * 0.18;
    drawSquad(app, sq, p.x, p.y - s * 0.05 - hop, s, tm, false);
  }

  // 初回の案内: 選んでほしい部隊のタイルを脈打つ枠で示す
  if (V.guide && V.guide.step === 'squad' && V.guide.tile != null) {
    const pk = motion() ? (tm % 1200) / 1200 : 0.3;
    for (const c of cells) {
      if (c.tile !== V.guide.tile) continue;
      hexPath(ctx, c.x, c.y, s * (1 + pk * 0.35));
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = `rgba(255,227,160,${0.9 * (1 - pk)})`;
      ctx.stroke();
      hexPath(ctx, c.x, c.y, s - 1);
      ctx.lineWidth = 2;
      ctx.strokeStyle = ACCENT_HI;
      ctx.stroke();
    }
  }

  // 選んだタイル（点線が回る）
  if (app.ui.tile != null) {
    for (const c of cells) {
      if (c.tile !== app.ui.tile) continue;
      hexPath(ctx, c.x, c.y, s - 1);
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#f2ecfa';
      ctx.setLineDash([4, 3]);
      ctx.lineDashOffset = motion() ? -tm / 50 : 0;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
    }
  }
  if (V.flagDraw) { V.flagDraw(); V.flagDraw = null; }
  // タップの波紋（ヘックスの形で広がって消える）
  for (const tp of V.taps) {
    const k = Math.min(1, (tm - tp.t0) / TAP_MS);
    const e = 1 - Math.pow(1 - k, 3);
    for (const c of cells) {
      if (c.tile !== tp.tile) continue;
      hexPath(ctx, c.x, c.y, s * (0.55 + 0.6 * e));
      ctx.fillStyle = `rgba(255,240,205,${0.16 * (1 - k)})`;
      ctx.fill();
      ctx.lineWidth = 0.5 + 2.5 * (1 - k);
      ctx.strokeStyle = `rgba(255,240,205,${0.9 * (1 - k)})`;
      ctx.stroke();
    }
  }
  // 陥落した砦の旗が変わる瞬間（新しい持ち主の色の輪が広がる）
  for (const ff of V.flagFx) {
    const k = Math.min(1, Math.max(0, (tm - ff.t0) / ff.dur));
    const e = 1 - Math.pow(1 - k, 3);
    for (const c of cells) {
      if (c.tile !== ff.tile) continue;
      hexPath(ctx, c.x, c.y, s * (0.9 + 0.7 * e));
      ctx.lineWidth = 2 + 4 * (1 - k);
      ctx.strokeStyle = alpha(ff.color, 0.95 * (1 - k));
      ctx.stroke();
      hexPath(ctx, c.x, c.y, s - 2);
      ctx.fillStyle = alpha(ff.color, 0.35 * (1 - k));
      ctx.fill();
    }
  }
  // 浮く文字（ダメージ・奇襲・回避）。出る瞬間に弾んでから昇る。画面の端から 24px 内側に収める
  for (const f of V.floats) {
    const age = tm - f.t0;
    if (age < 0) continue;
    const k = Math.min(1, age / f.dur);
    const p = toScreen(app, f.wx, f.wy);
    const mo = motion();
    if (f.kind === 'label') {
      drawSkillLabel(ctx, f, p, s, k, mo);
      continue;
    }
    const pop = !mo ? 1 : k < 0.1 ? 0.4 + (k / 0.1) * 1.05 : k < 0.24 ? 1.45 - ((k - 0.1) / 0.14) * 0.45 : 1;
    const rise = !mo ? 0 : Math.max(0, k - 0.24) * s * 1.1;
    ctx.globalAlpha = k > 0.75 ? (1 - k) / 0.25 : 1;
    const size = Math.max(15, s * f.scale) * pop;
    ctx.font = `900 ${size}px "Hiragino Sans","Noto Sans JP",sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(f.text).width;
    const y0 = p.y - s * 0.6 - rise + f.dy;
    // 画面のすぐ外（半分切れる程度）なら内側へ寄せる。遠く離れた所の数字は出さない（端に張り付かせない）
    if (p.x < -NEAR || p.x > V.cw + NEAR || y0 < -NEAR || y0 > V.ch + NEAR) { ctx.globalAlpha = 1; continue; }
    const x = Math.min(V.cw - FLOAT_MARGIN - tw / 2, Math.max(FLOAT_MARGIN + tw / 2, p.x));
    const y = Math.min(V.ch - FLOAT_MARGIN - size / 2, Math.max(FLOAT_MARGIN + size / 2, y0));
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(3, size * 0.2);
    ctx.strokeStyle = 'rgba(10,8,16,.92)';
    ctx.strokeText(f.text, x, y);
    ctx.fillStyle = f.color;
    ctx.fillText(f.text, x, y);
    if (f.shine) {
      ctx.fillStyle = 'rgba(255,255,255,.55)';
      ctx.save();
      ctx.beginPath();
      ctx.rect(x - size * 3, y - size * 0.6, size * 6, size * 0.45);
      ctx.clip();
      ctx.fillText(f.text, x, y);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }
}

/** スキル名の帯: ダメージの数字が出る位置の 28px 上に、暗い帯（高さ 20px）で。出て、少し留まって、消える */
function drawSkillLabel(ctx, f, p, s, k, mo) {
  const fs = 12;
  ctx.font = `900 ${fs}px "Hiragino Sans","Noto Sans JP",sans-serif`;
  const tw = ctx.measureText(f.text).width;
  const w = tw + 22;
  const H = 20;
  const ny = p.y - s * 0.6;
  if (p.x < -NEAR || p.x > V.cw + NEAR || ny < -NEAR || ny > V.ch + NEAR) return;
  const x = Math.min(V.cw - FLOAT_MARGIN - w / 2, Math.max(FLOAT_MARGIN + w / 2, p.x));
  const y = Math.max(FLOAT_MARGIN + H / 2, ny - 28);
  const inK = mo ? Math.min(1, k / 0.18) : 1;
  const outA = k > 0.82 ? (1 - k) / 0.18 : 1;
  const sx = 0.6 + 0.4 * (1 - Math.pow(1 - inK, 3));
  ctx.save();
  ctx.globalAlpha = outA * inK;
  ctx.translate(x, y);
  ctx.scale(sx, 1);
  ctx.fillStyle = 'rgba(0,0,0,.6)';
  ctx.beginPath();
  ctx.moveTo(-w / 2 + 6, -H / 2);
  ctx.lineTo(w / 2, -H / 2);
  ctx.lineTo(w / 2 - 6, H / 2);
  ctx.lineTo(-w / 2, H / 2);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = ACCENT;
  ctx.fillRect(-w / 2 + 2, -H / 2, 3, H);
  ctx.strokeStyle = 'rgba(255,227,160,.5)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(-w / 2 + 6, -H / 2 + 0.5);
  ctx.lineTo(w / 2, -H / 2 + 0.5);
  ctx.stroke();
  ctx.fillStyle = '#fff1c8';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(f.text, 3, 0.5);
  ctx.restore();
}

function drawStack(app, c, list, s, tm, crowded) {
  const ctx = V.ctx;
  const me = app.state.playerLand;
  const selId = !app.ui.executing ? app.ui.selectedSquad : null;
  // 手前ほど後ろに並べる: 敵 → 自分 → 選択中
  list.sort((a, b) => ((a.land === me) - (b.land === me)) || ((a.id === selId) - (b.id === selId)));
  const n = Math.min(list.length, 3);
  const shown = list.slice(list.length - n);
  const sel = shown.find((q) => q.id === selId) || null;
  const base = crowded ? s * 0.56 : (n > 1 ? s * 0.68 : s);
  const yy = crowded ? c.y + s * 0.4 : c.y - s * 0.05;
  const k = s / BASE;
  const spread = 14 * Math.max(0.8, Math.min(1.6, k));
  // 扇の位置（選択中は真ん中へ）
  const order = sel ? shown.filter((q) => q !== sel) : shown.slice();
  const slots = n === 1 ? [0] : n === 2 ? [-0.75, 0.75] : [-1, 0, 1];
  const placed = [];
  if (sel && n > 1) {
    // 選択中は扇の真ん中（2 体なら右）に、ほかは両脇へ
    const pos = n === 3 ? [0, 2] : [0];
    order.forEach((q, i) => placed.push({ sq: q, slot: slots[pos[i]] }));
    placed.push({ sq: sel, slot: slots[1] });
  } else {
    shown.forEach((q, i) => placed.push({ sq: q, slot: slots[i] }));
  }
  for (const pl of placed) {
    const x = c.x + pl.slot * spread;
    const y = yy + Math.abs(pl.slot) * spread * 0.18;
    const big = pl.sq === sel && n > 1 ? 1.25 : 1;
    if (n > 1 && pl.slot !== 0 && pl.sq !== sel) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(pl.slot * 0.14);
      drawSquad(app, pl.sq, 0, 0, base, tm, true, big);
      ctx.restore();
    } else drawSquad(app, pl.sq, x, y, base, tm, true, big);
  }
  // 描ききれない数（4 体以上）は右下にピル
  if (list.length > n && s >= 12) {
    const label = `x${list.length}`;
    ctx.font = '800 11px sans-serif';
    const w = ctx.measureText(label).width + 10;
    const px = c.x + s * 0.55;
    const py = c.y + s * 0.62;
    roundRect(ctx, px - w / 2, py - 8, w, 16, 8);
    ctx.fillStyle = INK;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.35)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#f2ecfa';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, px, py + 0.5);
  }
}

function drawSquad(app, sq, x, y, s, tm, idle, big = 1) {
  const ctx = V.ctx;
  const st = app.state;
  const mine = sq.land === st.playerLand;
  const selected = app.ui.selectedSquad === sq.id && !app.ui.executing;
  const size = Math.max(14, s * 1.15) * (selected ? Math.max(1.06, big) : big);
  const half = size / 2;
  const mo = motion();
  // 攻撃の踏み込み（攻撃側が少し前に出て戻る）
  const lg = V.lunges.get(sq.id);
  if (lg) {
    const k = Math.min(1, (tm - lg.t0) / lg.dur);
    const out = k < 0.35 ? k / 0.35 : 1 - (k - 0.35) / 0.65;
    const d = (k < 0.35 ? out * out : out) * s * 0.5;
    x += lg.ux * d;
    y += lg.uy * d;
  }
  // 待機中の揺れ（部隊ごとに位相をずらす）
  const bob = idle && mo && sq.status !== 'routed' ? (Math.sin(tm / 560 + hashId(sq.id) * 6.28) * 0.5 + 0.5) * s * 0.07 : 0;
  // 足もとの影（浮くと小さく）
  ctx.globalAlpha = sq.status === 'routed' ? 0.5 : 1;
  ctx.fillStyle = 'rgba(0,0,0,.42)';
  ctx.beginPath();
  ctx.ellipse(x, y + half * 0.98, half * (0.78 - bob / s * 0.8), half * 0.2, 0, 0, Math.PI * 2);
  ctx.fill();
  // 選択の光の輪（足もとに広がる + 脈打つ）
  if (selected) {
    const k = V.selFx && mo ? Math.min(1, (tm - V.selFx.t0) / 520) : 1;
    const e = k < 1 ? 1 + 2.2 * Math.pow(k - 1, 3) + 1.2 * Math.pow(k - 1, 2) : 1;
    const rx = half * 1.15 * e;
    ctx.fillStyle = 'rgba(255,214,120,.18)';
    ctx.beginPath();
    ctx.ellipse(x, y + half * 0.98, rx, rx * 0.34, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = ACCENT_HI;
    ctx.stroke();
    if (mo) {
      const p = ((tm - (V.selFx ? V.selFx.t0 : 0)) % 1400) / 1400;
      const r2 = half * (1.15 + p * 0.9);
      ctx.lineWidth = 2;
      ctx.strokeStyle = `rgba(255,227,160,${0.7 * (1 - p)})`;
      ctx.beginPath();
      ctx.ellipse(x, y + half * 0.98, r2, r2 * 0.34, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  y -= bob;
  const r = Math.max(3, size * 0.18);
  const col = mine ? landColor(app.db, sq.land) : ENEMY_COLOR;
  // 外側の光（彩度を上げて地形から浮かせる）
  roundRect(ctx, x - half - 1, y - half - 1, size + 2, size + 2, r + 1);
  ctx.lineWidth = Math.max(4, size * 0.16);
  ctx.strokeStyle = alpha(selected ? ACCENT : col, selected ? 0.45 : 0.3);
  ctx.stroke();
  roundRect(ctx, x - half, y - half, size, size, r);
  const g = ctx.createLinearGradient(0, y - half, 0, y + half);
  g.addColorStop(0, 'rgba(46,40,64,.95)');
  g.addColorStop(1, 'rgba(16,14,22,.95)');
  ctx.fillStyle = g;
  ctx.fill();
  const hero = heroOf(app.db, sq);
  const im = hero ? getImage(hero.image) : null;
  if (im) ctx.drawImage(im, x - half, y - half, size, size);
  else {
    ctx.fillStyle = landColor(app.db, sq.land);
    ctx.beginPath();
    ctx.arc(x, y, half * 0.55, 0, Math.PI * 2);
    ctx.fill();
  }
  roundRect(ctx, x - half, y - half, size, size, r);
  ctx.lineWidth = mine ? 2 : 2.5;
  ctx.strokeStyle = selected ? ACCENT_HI : col;
  ctx.stroke();
  // 上辺のハイライト（物の質感）
  ctx.strokeStyle = 'rgba(255,255,255,.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x - half + r, y - half + 1.5);
  ctx.lineTo(x + half - r, y - half + 1.5);
  ctx.stroke();
  // 自分の部隊には、指示のステータスの小さな印（未指示: 白 / 指示中: 金の半円 / 完了: 緑のチェック）
  if (mine && !app.ui.executing && !selected && size >= 18) {
    const kind = orderStatus(app, sq);
    const rr = Math.max(4, size * 0.16);
    const bx = x + half - rr * 0.4;
    const by = y - half + rr * 0.4;
    ctx.beginPath();
    ctx.arc(bx, by, rr + 1.5, 0, Math.PI * 2);
    ctx.fillStyle = INK;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(bx, by, rr, 0, Math.PI * 2);
    ctx.fillStyle = kind === 'done' ? '#6fcf8f' : kind === 'doing' ? '#3a3448' : kind === 'off' ? '#5a5466' : '#d8d0ee';
    ctx.fill();
    if (kind === 'doing') {
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.arc(bx, by, rr, -Math.PI / 2, Math.PI / 2);
      ctx.closePath();
      ctx.fillStyle = ACCENT;
      ctx.fill();
    } else if (kind === 'done') {
      ctx.strokeStyle = INK;
      ctx.lineWidth = Math.max(1.2, rr * 0.35);
      ctx.beginPath();
      ctx.moveTo(bx - rr * 0.45, by);
      ctx.lineTo(bx - rr * 0.1, by + rr * 0.38);
      ctx.lineTo(bx + rr * 0.5, by - rr * 0.38);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

/** 経路の点を、ループを跨いでも繋がる画面座標の列に */
function pathPoints(app, startTile, path) {
  const st = app.state;
  const P = period(st);
  const start = tileWorld(st, startTile);
  const pts = [toScreen(app, start.x, start.y)];
  let wx = start.x;
  let prev = start;
  for (const i of path) {
    const p = tileWorld(st, i);
    let dx = p.x - prev.x;
    dx = ((dx % P) + P * 1.5) % P - P / 2;
    wx += dx;
    prev = p;
    const z = app.ui.mapCam.zoom;
    pts.push({ x: pts[0].x + (wx - start.x) * z, y: V.ch / 2 + (p.y - app.ui.mapCam.y) * z });
  }
  return pts;
}

/** 点列を、先頭から長さ len までで切った点列 */
function cutPolyline(pts, len) {
  const out = [pts[0]];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    if (acc + d >= len) {
      const k = d > 0 ? (len - acc) / d : 0;
      out.push({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, cut: true, i });
      return out;
    }
    acc += d;
    out.push(b);
  }
  return out;
}

function polyLength(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return L;
}

function strokeLine(ctx, pts) {
  if (pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
}

/**
 * 経路のプレビュー: ヘックスの中心をたどる折れ線が、出発地から伸びる（stroke-dashoffset を 0 へ動かすのと同じ見え方。
 * 1 マス 60ms・上限 500ms。カメラが寄りきってから始める＝notePlan / openTile が t0 を後ろへずらす）。
 * 今日届く分は金の実線、翌日以降は点線。日の変わり目に日数の丸、終点に到着予定日の旗
 */
function drawPath(app, sq, plan, s, tm) {
  const ctx = V.ctx;
  const pts = pathPoints(app, plan.from, plan.path);
  // 各歩が何日目に届くか（コストはエンジンの stepCost、1 日の AP はエンジンの apMax）
  const hero = heroOf(app.db, sq);
  const max = apMax(hero, sq, app.db) || 0;
  const ap = sq.ap || 0;
  const dayOf = [1];
  let acc = 0;
  for (let i = 0; i < plan.path.length; i++) {
    acc += stepCost(app.state, app.db, sq, hero, plan.path[i]);
    dayOf.push(acc <= ap ? 1 : max > 0 ? 1 + Math.ceil((acc - ap) / max) : 2);
  }
  let split = pts.length - 1;
  for (let j = 1; j < pts.length; j++) if (dayOf[j] > 1) { split = j - 1; break; }

  const mo = motion();
  const fxp = V.pathFx;
  const t0 = fxp ? fxp.t0 : 0;
  const dur = fxp ? fxp.dur : 1;
  // カメラが寄っている間は、出発地の点だけ（線はまだ伸ばさない）
  if (mo && tm < t0) {
    const p0 = pts[0];
    const pk = (tm % 700) / 700;
    ctx.fillStyle = alpha(ACCENT_HI, 0.9);
    ctx.beginPath();
    ctx.arc(p0.x, p0.y, Math.max(3, s * 0.12) * (1 + pk * 0.3), 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  const k = mo ? Math.min(1, (tm - t0) / dur) : 1;
  const grow = 1 - Math.pow(1 - k, 2);
  const total = polyLength(pts);
  const shown = cutPolyline(pts, total * grow);
  const lastIdx = shown[shown.length - 1].cut ? shown[shown.length - 1].i - 1 : pts.length - 1;
  const today = shown.slice(0, Math.min(shown.length, split + 1));
  if (shown[shown.length - 1].cut && lastIdx < split) today.push(shown[shown.length - 1]);
  const later = lastIdx >= split ? shown.slice(split) : [];

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const lw = Math.max(3, s * 0.14);
  // 下敷き（暗い太線で地形から浮かせる）
  ctx.lineWidth = lw + 4;
  ctx.strokeStyle = 'rgba(8,7,12,.7)';
  strokeLine(ctx, shown);
  // 今日の分: 光 + 金の実線
  ctx.lineWidth = lw + 6;
  ctx.strokeStyle = alpha(ACCENT, 0.25);
  strokeLine(ctx, today);
  ctx.lineWidth = lw;
  ctx.strokeStyle = ACCENT;
  strokeLine(ctx, today);
  ctx.lineWidth = Math.max(1, lw * 0.35);
  ctx.strokeStyle = 'rgba(255,248,225,.75)';
  strokeLine(ctx, today);
  // 翌日以降: 点線（流れる）
  if (later.length >= 2) {
    ctx.lineWidth = lw * 0.85;
    ctx.strokeStyle = LATER;
    ctx.setLineDash([lw * 1.6, lw * 1.4]);
    ctx.lineDashOffset = mo ? -tm / 40 : 0;
    strokeLine(ctx, later);
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
  }
  // 通るヘックスの中心に小さな点（線がヘックスをたどっていると分かる）
  for (let j = 1; j < pts.length - 1 && j <= lastIdx; j++) {
    ctx.fillStyle = dayOf[j] === 1 ? 'rgba(255,248,225,.9)' : alpha(LATER, 0.9);
    ctx.beginPath();
    ctx.arc(pts[j].x, pts[j].y, Math.max(1.6, lw * 0.32), 0, Math.PI * 2);
    ctx.fill();
  }
  // 今日の分を流れる光の粒
  if (mo && k >= 1 && today.length >= 2) {
    const L = polyLength(today);
    if (L > 4) {
      const pos = cutPolyline(today, ((tm - t0) % 1100) / 1100 * L);
      const q = pos[pos.length - 1];
      const gr = ctx.createRadialGradient(q.x, q.y, 0, q.x, q.y, lw * 1.8);
      gr.addColorStop(0, 'rgba(255,255,240,.95)');
      gr.addColorStop(1, 'rgba(255,240,200,0)');
      ctx.fillStyle = gr;
      ctx.beginPath();
      ctx.arc(q.x, q.y, lw * 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // 日の変わり目（翌日以降の最初の歩の手前）に日数の丸
  const fs = Math.max(11, s * 0.3);
  ctx.font = `900 ${fs}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let j = 1; j < pts.length - 1; j++) {
    if (dayOf[j + 1] === dayOf[j] || j > lastIdx) continue;
    const p = pts[j];
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.arc(p.x, p.y, fs * 0.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = dayOf[j] === 1 ? ACCENT : LATER;
    ctx.stroke();
    ctx.fillStyle = '#f2ecfa';
    ctx.fillText(String(dayOf[j]), p.x, p.y + 0.5);
  }
  // 伸びている途中の先端
  if (k < 1) {
    const q = shown[shown.length - 1];
    ctx.fillStyle = ACCENT_HI;
    ctx.beginPath();
    ctx.arc(q.x, q.y, lw * 0.9, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  // 到着予定日の旗（伸びきったら、立って弾む）
  const end = pts[pts.length - 1];
  const days = plan.days != null ? plan.days : dayOf[dayOf.length - 1];
  // 旗は、選んだタイルの点線より手前に描く（draw の最後で）
  const pk = mo ? Math.min(1, (tm - t0 - dur) / 360) : 1;
  V.flagDraw = () => drawDayFlag(ctx, app, end, days, s, pk, mo);
}

/** 到着予定日の旗: 竿の先に高さ 22px の旗。「2日」を 12px で（SPEC-112 §3） */
function drawDayFlag(ctx, app, end, days, s, pk, mo) {
  const e = mo ? 1 + 2.6 * Math.pow(pk - 1, 3) + 1.6 * Math.pow(pk - 1, 2) : 1;
  const label = fmt(t(app, 'map.daysUnit'), { n: days }).replace(/\s+/g, '');
  const col = days <= 1 ? ACCENT : LATER;
  const FH = 22;
  const pole = 32 * Math.max(0.2, e);
  const base = { x: end.x, y: end.y };
  // 足もとの影と台座
  ctx.fillStyle = 'rgba(0,0,0,.45)';
  ctx.beginPath();
  ctx.ellipse(base.x, base.y + 1, 7 * (0.6 + 0.4 * pk), 2.6, 0, 0, Math.PI * 2);
  ctx.fill();
  // 竿
  ctx.strokeStyle = '#f2ecfa';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(base.x, base.y);
  ctx.lineTo(base.x, base.y - pole);
  ctx.stroke();
  ctx.fillStyle = '#f2ecfa';
  ctx.beginPath();
  ctx.arc(base.x, base.y - pole, 2.2, 0, Math.PI * 2);
  ctx.fill();
  // 旗（竿の右へ。端は燕尾）
  ctx.font = `900 12px "Hiragino Sans","Noto Sans JP",sans-serif`;
  const tw = ctx.measureText(label).width;
  const fw = tw + 16;
  const fx0 = base.x + 1;
  const fy0 = base.y - pole + 1;
  const wave = mo ? Math.sin(now() / 260) * 1.2 : 0;
  ctx.beginPath();
  ctx.moveTo(fx0, fy0);
  ctx.lineTo(fx0 + fw, fy0 + wave);
  ctx.lineTo(fx0 + fw - 5, fy0 + FH / 2 + wave * 0.5);
  ctx.lineTo(fx0 + fw, fy0 + FH + wave);
  ctx.lineTo(fx0, fy0 + FH);
  ctx.closePath();
  ctx.fillStyle = col;
  ctx.shadowColor = 'rgba(0,0,0,.5)';
  ctx.shadowBlur = 6;
  ctx.shadowOffsetY = 2;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  // 上辺の光
  ctx.strokeStyle = 'rgba(255,255,255,.55)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(fx0 + 2, fy0 + 1.5);
  ctx.lineTo(fx0 + fw - 3, fy0 + 1.5 + wave);
  ctx.stroke();
  ctx.fillStyle = INK;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, fx0 + 6, fy0 + FH / 2 + 0.5 + wave * 0.5);
}

/** 攻撃のプレビュー: 部隊から目標へ弧を描く線と、回る照準 */
function drawAim(app, sq, plan, s, tm) {
  const ctx = V.ctx;
  const st = app.state;
  const a = tileWorld(st, plan.from);
  const b = tileWorld(st, plan.tile);
  const pa = toScreen(app, a.x, a.y);
  const P = period(st);
  let dx = b.x - a.x;
  dx = ((dx % P) + P * 1.5) % P - P / 2;
  const z = app.ui.mapCam.zoom;
  const pb = { x: pa.x + dx * z, y: pa.y + (b.y - a.y) * z };
  const col = plan.ok ? ENEMY_COLOR : '#cfc6e4';
  const mo = motion();
  const k = mo && V.pathFx ? Math.max(0, Math.min(1, (tm - V.pathFx.t0) / V.pathFx.dur)) : 1;
  const e = 1 - Math.pow(1 - k, 3);
  // 弧
  const mx = (pa.x + pb.x) / 2;
  const my = (pa.y + pb.y) / 2 - Math.hypot(pb.x - pa.x, pb.y - pa.y) * 0.35;
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(2.5, s * 0.1);
  ctx.strokeStyle = alpha(col, 0.9);
  ctx.setLineDash([s * 0.25, s * 0.18]);
  ctx.lineDashOffset = mo ? -tm / 30 : 0;
  ctx.beginPath();
  const N = 24;
  for (let i = 0; i <= N * e; i++) {
    const u = i / N;
    const x = (1 - u) * (1 - u) * pa.x + 2 * (1 - u) * u * mx + u * u * pb.x;
    const y = (1 - u) * (1 - u) * pa.y + 2 * (1 - u) * u * my + u * u * pb.y;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;
  if (k < 1) return;
  // 照準（4 つの角が回りながら締まる）
  const pulse = mo ? Math.sin(tm / 180) * 0.06 : 0;
  const rr = s * (0.95 + pulse);
  const rot = mo ? tm / 900 : 0;
  ctx.lineWidth = Math.max(2, s * 0.09);
  ctx.strokeStyle = col;
  for (let q = 0; q < 4; q++) {
    const ang = rot + q * Math.PI / 2;
    ctx.beginPath();
    ctx.arc(pb.x, pb.y, rr, ang - 0.32, ang + 0.32);
    ctx.stroke();
  }
  ctx.fillStyle = alpha(col, 0.16);
  hexPath(ctx, pb.x, pb.y, s - 2);
  ctx.fill();
}

/** 積んである移動（薄く） */
function drawQueued(app, sq, s, tm) {
  const ctx = V.ctx;
  let from = sq.tile;
  for (const o of sq.orders || []) {
    if (o.type !== 'move' || !Array.isArray(o.path) || !o.path.length) continue;
    const pts = pathPoints(app, from, o.path);
    ctx.lineWidth = Math.max(2, s * 0.1);
    ctx.strokeStyle = 'rgba(242,236,250,.8)';
    ctx.setLineDash([3, 4]);
    ctx.lineDashOffset = motion() ? -tm / 70 : 0;
    strokeLine(ctx, pts);
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
    const end = pts[pts.length - 1];
    ctx.fillStyle = 'rgba(242,236,250,.9)';
    ctx.beginPath();
    ctx.arc(end.x, end.y, Math.max(3, s * 0.12), 0, Math.PI * 2);
    ctx.fill();
    from = o.path[o.path.length - 1];
  }
}

/** 到達範囲（積んだ移動の後の位置から、残り AP で） */
function reachOf(app, sq) {
  const here = projectedTile(sq);
  const key = `${sq.id}:${sq.tile}:${here}:${sq.ap}:${(sq.orders || []).length}:${app.state.day}`;
  if (V.reach && V.reach.key === key) return V.reach.map;
  let map = null;
  if ((sq.ap || 0) > 0) {
    const at = here === sq.tile ? sq : { ...sq, tile: here };
    try { map = reachable(app.state, app.db, at, heroOf(app.db, sq), sq.ap); } catch (e) { console.error(e); }
  }
  V.reach = { key, map };
  return map;
}

// ------------------------------------------------------------
// 経路のプレビューと指示
// ------------------------------------------------------------

function makePlan(app, sq, tile) {
  const st = app.state;
  const db = app.db;
  const hero = heroOf(db, sq);
  const from = projectedTile(sq);
  const target = isVisible(app, tile) ? targetAt(st, sq.land, tile) : null;
  if (target) {
    const v = validate(st, db, sq, { type: 'attack', target: tile });
    const siege = !!(target.home || typeof target.rank === 'string');
    // 落ちたばかりの砦は実行時に止まるので、ここで先に知らせる（判定は engine の isShielded）
    const shielded = typeof target.rank === 'string' && isShielded(st, target);
    return { kind: 'attack', squad: sq.id, tile, from, ok: v.ok && !shielded, reason: shielded ? 'shield' : v.reason, siege, name: targetName(app, target), range: rangeOf(hero) };
  }
  const at = from === sq.tile ? sq : { ...sq, tile: from };
  const p = findPath(st, db, at, hero, tile);
  if (!p || !p.path.length) return { kind: 'move', squad: sq.id, tile, from, path: null, ok: false, reason: 'terrain' };
  const max = apMax(hero, sq, db);
  const days = max > 0 ? Math.max(1, Math.ceil(p.cost / max)) : null;
  const v = validate(st, db, sq, { type: 'move', path: p.path });
  return { kind: 'move', squad: sq.id, tile, from, path: p.path, cost: p.cost, days, ok: v.ok, reason: v.reason };
}

/** 新しい経路が引かれたら、線が伸びる演出を最初から */
function notePlan(plan) {
  if (!V) return;
  const key = plan ? `${plan.squad}:${plan.from}:${plan.tile}:${plan.kind}` : null;
  if (key && (!V.pathFx || V.pathFx.key !== key)) {
    const steps = plan.path ? plan.path.length : 4;
    V.pathFx = { key, t0: now() + (motion() ? ROUTE_CAM_MS : 0), dur: Math.min(PATH_MAX_MS, Math.max(PATH_STEP_MS * 2, PATH_STEP_MS * steps)) };
  }
  if (!key) V.pathFx = null;
}

function rejectText(app, sq, reason, kind) {
  const hero = heroOf(app.db, sq);
  if (['ap', 'home', 'range', 'build'].includes(reason)) return say(app.db, hero, `order.reject.${reason}`, { ap: sq.ap || 0, kind });
  if (reason === 'terrain' || reason === 'path') return t(app, 'map.unreachable');
  return t(app, 'map.reject');
}

function applyPlan(app) {
  const ui = mv(app);
  const plan = ui.plan;
  const st = app.state;
  const sq = plan ? st.squads[plan.squad] : null;
  if (!plan || !sq || app.ui.executing) return;
  const hero = heroOf(app.db, sq);
  const order = plan.kind === 'attack' ? { type: 'attack', target: plan.tile } : { type: 'move', path: plan.path };
  const r = queue(st, app.db, sq.id, order);
  if (!r.ok) {
    toast(rejectText(app, sq, r.reason), { key: 'map-reject', kind: 'bad' });
    ui.plan = makePlan(app, sq, plan.tile);
    renderSheet(app);
    return;
  }
  const text = plan.kind === 'attack'
    ? say(app.db, hero, 'order.attack.ack', { target: plan.name })
    : say(app.db, hero, 'order.move.ack', { dest: tileTitle(app, plan.tile), days: plan.days ?? '-' });
  toast(text, { key: 'map-ack', kind: 'good', icon: hero ? hero.image : undefined });
  try { save(st); } catch (e) { console.error(e); }
  // 決めた場所に金の波紋
  if (V) V.taps.push({ tile: plan.tile, t0: now() });
  ui.plan = null;
  notePlan(null);
  if (V) V.reach = null;
  // 経路を確定したら案内は役目を終える（自動で閉じる）
  if (V && V.guide) endGuide(true);
  renderSheet(app);
  renderOverlay(app);
  requestDraw();
  // AP を使い切ったら、ロスターの順で次の動けるヒーローへ選び直す（少し待って、確定の手応えを見せてから）
  if (V && (sq.ap || 0) <= 0) {
    later(() => {
      if (!V || app.ui.executing || app.ui.selectedSquad !== sq.id) return;
      const nx = nextActive(app, sq.id);
      if (nx) {
        app.ui.tile = null;
        renderSheet(app);
        selectSquad(app, nx.id);
      } else {
        renderOverlay(app);
      }
    }, 650);
  }
}

/** マウントしている間だけのタイマー（外したら止める） */
function later(fn, ms) {
  if (!V) return 0;
  const id = setTimeout(() => {
    if (V) V.timers.delete(id);
    fn();
  }, Math.max(0, ms));
  V.timers.add(id);
  return id;
}

function selectSquad(app, id, { fly = true } = {}) {
  const prev = app.ui.selectedSquad;
  app.ui.selectedSquad = id;
  const ui = mv(app);
  ui.plan = null;
  notePlan(null);
  ui.focusedSquad = id;
  if (V) {
    V.reach = null;
    if (id != null && id !== prev) V.selFx = { id, t0: now() };
  }
  const sq = id != null ? app.state.squads[id] : null;
  if (sq && fly && V) {
    const b = viewBand();
    const mid = (b.top + b.bottom) / 2;
    flyTo(app, sq.tile, { zoom: Math.max(app.ui.mapCam.zoom, ZOOM_FOCUS), offsetY: V.ch / 2 - mid });
  }
  renderSheet(app);
  renderOverlay(app);
  requestDraw();
}

function openTile(app, tile) {
  const ui = mv(app);
  const prevTile = app.ui.tile;
  app.ui.tile = tile;
  const sq = !app.ui.executing ? selectedSquad(app) : null;
  ui.plan = sq && tile !== projectedTile(sq) ? makePlan(app, sq, tile) : null;
  notePlan(ui.plan);
  renderSheet(app, { swap: prevTile != null && prevTile !== tile });
  updateGuide(app);
  requestDraw();
  // カメラを寄せきってから線を伸ばす（--t-page 600ms の前半でカメラ、後半で線）
  const fxp = V ? V.pathFx : null;
  requestAnimationFrame(() => {
    if (!V) return;
    const moved = ensureVisible(app, tile, ui.plan ? ui.plan.from : null, ROUTE_CAM_MS);
    if (fxp && V.pathFx === fxp) fxp.t0 = now() + (moved ? ROUTE_CAM_MS : 0);
    requestDraw();
  });
}

function closeSheet(app) {
  app.ui.tile = null;
  mv(app).plan = null;
  notePlan(null);
  renderSheet(app);
  updateGuide(app);
  requestDraw();
}

/** 「＜ 戻る」: 1 つ前へ（凡例 → シート → 地図 → ホーム。SPEC-112 §7.5.1） */
function goBack(app) {
  if (V && V.legendOpen) { toggleLegend(app, false); return; }
  if (app.ui.tile != null) { closeSheet(app); return; }
  go('home');
}

// ------------------------------------------------------------
// DOM（情報シート・上の札・ターン終了・凡例・案内）
// ------------------------------------------------------------

function row(label, ...value) {
  return h('div', { class: 'map-sheet__row' }, h('dt', null, label), h('dd', null, ...value));
}

function heroThumb(hero, cls, size) {
  if (!hero) return null;
  const node = h('img', { class: `${cls} hero-img`, src: img(hero.image), alt: hero.name, width: size, height: size, loading: 'lazy' });
  node.addEventListener('error', () => { node.replaceWith(h('span', { class: `${cls} img-fallback`, role: 'img', 'aria-label': hero.name }, hero.name.slice(0, 1))); }, { once: true });
  return node;
}

function squadItem(app, sq) {
  const st = app.state;
  const db = app.db;
  const hero = heroOf(db, sq);
  const mine = sq.land === st.playerLand;
  const max = mine && hero ? apMax(hero, sq, db) : null;
  const body = [
    heroThumb(hero, 'map-squad__img', 40),
    h('span', { class: 'map-squad__text' },
      h('span', { class: 'map-squad__name' }, hero ? hero.name : sq.id),
      h('span', { class: 'map-squad__sub num' },
        mine ? null : h('span', { class: 'map-squad__land', style: { '--land': landColor(db, sq.land) } }, landName(app, sq.land)),
        `${t(app, 'map.troops')} ${sq.troops}`,
        mine ? `  ${t(app, 'map.apLeft')} ${sq.ap || 0} / ${max}` : null,
        sq.status === 'routed' ? h('span', { class: 'map-squad__tag' }, t(app, 'map.routed')) : null)),
  ];
  if (!mine || app.ui.executing) return h('li', { class: ['map-squad', mine ? 'is-mine' : 'is-enemy'] }, body);
  const selected = app.ui.selectedSquad === sq.id;
  return h('li', { class: 'map-squad is-mine' },
    h('button', {
      class: ['map-squad__btn', 'panel--press', selected ? 'is-selected' : null], type: 'button', 'aria-pressed': selected ? 'true' : 'false',
      onClick: () => selectSquad(app, selected ? null : sq.id),
    }, body, h('span', { class: 'map-squad__pick' }, selected ? t(app, 'map.selected') : '')));
}

function planBlock(app, plan) {
  const st = app.state;
  const sq = st.squads[plan.squad];
  if (!sq) return null;
  const hero = heroOf(app.db, sq);
  if (plan.kind === 'attack') {
    const label = t(app, plan.siege ? 'map.siege' : 'map.attack');
    const note = plan.ok ? null
      : plan.reason === 'range' ? fmt(t(app, 'map.outOfRange'), { n: plan.range })
        : plan.reason === 'shield' ? t(app, 'map.shielded')
          : rejectText(app, sq, plan.reason);
    return h('div', { class: ['map-plan', 'map-plan--attack', plan.ok ? null : 'is-ng'] },
      h('div', { class: 'map-plan__who' },
        heroThumb(hero, 'map-plan__hero', 28),
        h('span', { class: 'map-plan__by' }, hero ? hero.name : sq.id),
        h('span', { class: 'map-plan__arrow', 'aria-hidden': 'true' }),
        h('p', { class: 'map-plan__target' }, plan.name)),
      plan.ok
        ? h('button', { class: ['btn-primary', 'map-plan__go', 'map-plan__go--attack'], type: 'button', 'data-ripple': 'accent', onClick: () => applyPlan(app) }, label)
        : altButton(app, sq, note));
  }
  if (!plan.path) return h('div', { class: 'map-plan is-ng' }, h('p', { class: 'map-plan__note' }, t(app, 'map.unreachable')));
  const over = (plan.cost || 0) > (sq.ap || 0);
  return h('div', { class: ['map-plan', plan.ok ? null : 'is-ng'] },
    h('dl', { class: 'map-plan__facts' },
      h('div', { class: ['map-plan__fact', plan.days > 1 ? 'is-later' : 'is-today'] }, h('dt', null, t(app, 'map.days')), h('dd', { class: 'num' }, plan.days != null ? fmt(t(app, 'map.daysUnit'), { n: plan.days }) : '-')),
      h('div', { class: 'map-plan__fact' }, h('dt', null, t(app, 'map.cost')), h('dd', { class: 'num' }, String(plan.cost))),
      h('div', { class: ['map-plan__fact', over ? 'is-over' : null] }, h('dt', null, t(app, 'map.apLeft')), h('dd', { class: 'num' }, String(sq.ap || 0)))),
    h('div', { class: 'map-plan__key', 'aria-hidden': 'true' },
      h('span', { class: 'map-plan__line map-plan__line--today' }), tx(app, 'map.legendRouteToday', '今日届く'),
      h('span', { class: 'map-plan__line map-plan__line--later' }), tx(app, 'map.legendRouteLater', '翌日以降')),
    plan.ok
      ? h('button', { class: 'btn-primary map-plan__go', type: 'button', 'data-ripple': 'accent', onClick: () => applyPlan(app) }, t(app, 'map.go'))
      : altButton(app, sq, rejectText(app, sq, plan.reason)));
}

/**
 * できないとき: 主役の金のボタンは出さず、副ボタン「別のヒーローを選ぶ」に差し替える。理由はボタンの中の 2 行目（SPEC-112 §7）。
 * 押すと、ロスターの順で次の動けるヒーローを選び、同じタイルへの経路を引き直す。動けるヒーローがいなければ「閉じる」
 */
function altButton(app, sq, reason) {
  const nx = nextActive(app, sq.id);
  const hero = nx ? heroOf(app.db, nx) : null;
  const main = nx
    ? fmt(tx(app, 'map.pickOther', '別のヒーローを選ぶ（{name}）'), { name: hero ? hero.name : nx.id })
    : tx(app, 'map.closeSheet', '閉じる');
  return h('button', {
    class: 'btn-secondary map-plan__alt', type: 'button', dataset: { act: nx ? 'other' : 'close' },
    onClick: () => {
      if (!nx) { closeSheet(app); return; }
      const tile = app.ui.tile;
      selectSquad(app, nx.id, { fly: false });
      if (tile != null) openTile(app, tile);
    },
  },
  h('span', { class: 'map-plan__alt-main' }, nx ? h('span', { class: 'map-plan__alt-face' }, heroThumb(hero, 'map-plan__alt-img', 24)) : null, main),
  reason ? h('span', { class: 'map-plan__alt-why' }, reason) : null);
}

function renderSheet(app, { swap = false } = {}) {
  if (!V || !V.sheet) return;
  const el = V.sheet;
  const tile = app.ui.tile;
  const st = app.state;
  const wasOpen = !el.hidden;
  if (tile == null || !st.map.tiles[tile]) {
    if (wasOpen) sheetGhost(el);
    clear(el);
    el.hidden = true;
    syncSheetHeight();
    return;
  }
  clear(el);
  el.hidden = false;
  const db = app.db;
  const tl = st.map.tiles[tile];
  const visible = isVisible(app, tile);
  const terr = db.terrain[tl.terrain];
  const plan = mv(app).plan;

  el.appendChild(h('div', { class: 'map-sheet__grip', 'aria-hidden': 'true' }));
  el.appendChild(h('header', { class: 'map-sheet__head' },
    terr ? h('span', { class: 'map-sheet__swatch', style: { '--sw': muted(terr.color) }, 'aria-hidden': 'true' }) : null,
    h('h2', { class: 'map-sheet__title', id: 'map-sheet-title' }, tileTitle(app, tile)),
    h('button', { class: 'btn-ghost map-sheet__x', type: 'button', 'aria-label': t(app, 'common.close'), onClick: () => closeSheet(app) }, '×')));

  if (plan) el.appendChild(planBlock(app, plan));

  if (!visible) {
    el.appendChild(h('p', { class: 'muted map-sheet__fog' }, t(app, 'map.unexplored')));
  } else {
    const y = terrainYield(db, tl.terrain);
    const rows = [
      row(t(app, 'map.terrain'), terr ? terr.name : tl.terrain),
      row(t(app, 'map.yield'), h('span', { class: 'map-sheet__yield num' },
        h('span', null, `${t(app, 'res.food')} `, h('b', null, String(y.food))),
        h('span', null, `${t(app, 'res.gum')} `, h('b', null, String(y.gum))),
        h('span', null, `${t(app, 'res.mat')} `, h('b', null, String(y.mat))))),
      row(t(app, 'map.owner'), tl.owner
        ? h('span', { class: 'map-sheet__land', style: { '--land': landColor(db, tl.owner) } }, landName(app, tl.owner))
        : t(app, 'map.noOwner')),
    ];
    const build = st.builds && st.builds[tile];
    if (tl.facility) {
      const fac = db.facilities[tl.facility.kind];
      rows.push(row(t(app, 'map.facility'), h('span', { class: 'num' }, `${fac ? fac.name : tl.facility.kind} ${t(app, 'facility.rank')} ${tl.facility.rank}`)));
    }
    if (build) {
      const fac = db.facilities[build.kind];
      rows.push(row(t(app, 'map.building'), h('span', { class: 'num' }, `${fac ? fac.name : build.kind}  ${fmt(t(app, 'map.daysLeft'), { n: build.daysLeft })}`)));
    }
    if (tl.fort && st.forts[tl.fort]) {
      const f = st.forts[tl.fort];
      const en = enemyOf(db, f.enemyId);
      const ratio = f.maxDurability > 0 ? f.durability / f.maxDurability : 0;
      rows.push(row(t(app, 'map.fort'),
        h('span', { class: 'map-sheet__fort', style: { '--rank': FORT_COLOR[f.rank] || ACCENT } }, t(app, `fort.${f.rank}`)),
        en ? ` ${en.name}` : ''));
      rows.push(row(t(app, 'fort.troops'), h('span', { class: 'num' }, String(f.troops))));
      rows.push(row(t(app, 'fort.durability'), h('span', { class: 'map-sheet__meter', style: { '--v': ratio, '--rank': FORT_COLOR[f.rank] || ACCENT } },
        h('span', { class: 'num' }, `${f.durability} / ${f.maxDurability}`), h('i', { 'aria-hidden': 'true' }))));
    }
    const home = homeAt(st, tile);
    if (home) {
      const dur = typeof home.land.homeDurability === 'number' ? home.land.homeDurability : 100;
      rows.push(row(t(app, 'map.home'), landName(app, home.id)));
      rows.push(row(t(app, 'map.homeDurability'), h('span', { class: 'map-sheet__meter', style: { '--v': dur / 100, '--rank': landColor(db, home.id) } },
        h('span', { class: 'num' }, `${dur} / 100`), h('i', { 'aria-hidden': 'true' }))));
    }
    el.appendChild(h('dl', { class: 'map-sheet__facts' }, rows));

    const list = squadsAt(st, tile);
    el.appendChild(h('h3', { class: 'section-title' }, t(app, 'map.squads')));
    el.appendChild(list.length
      ? h('ul', { class: 'map-squads' }, list.map((sq) => squadItem(app, sq)))
      : h('p', { class: 'muted map-sheet__empty' }, t(app, 'map.noSquads')));
  }
  // 開いたまま別のタイルへ: 中身だけ順に差し替わる（シートは動かない）
  if (wasOpen && swap) fx.stagger([...el.children].slice(1), { from: 'up', distance: 6, step: 25, ms: 260 });
  syncSheetHeight();
}

/** 閉じたシートの写し（押せない）を下へ沈めて消す。本物はすぐ隠す（押せる状態を残さない） */
function sheetGhost(el) {
  if (!motion() || !el.parentNode) return;
  const g = el.cloneNode(true);
  g.removeAttribute('id');
  for (const n of g.querySelectorAll('[id]')) n.removeAttribute('id');
  g.classList.add('map-sheet--ghost');
  g.setAttribute('aria-hidden', 'true');
  g.inert = true;
  el.after(g);
  const done = () => g.remove();
  g.addEventListener('animationend', done, { once: true });
  setTimeout(done, fx.token('--t-flip', 380) + 120);
}

/** シートの高さを CSS へ（案内をシートの上へ、ターン終了をシートの間だけ隠す） */
function syncSheetHeight() {
  if (!V) return;
  const hgt = V.sheet && !V.sheet.hidden ? V.sheet.offsetHeight : 0;
  V.el.style.setProperty('--sheet-h', `${hgt}px`);
  V.el.style.setProperty('--dock-h', `${V.dock && !V.dock.hidden ? V.dock.offsetHeight : 0}px`);
  V.el.classList.toggle('has-sheet', hgt > 0);
}

function renderOverlay(app) {
  if (!V) return;
  const ui = mv(app);
  const st = app.state;
  const exec = !!app.ui.executing;
  clear(V.chip);
  V.back.hidden = exec;
  const sq = !exec ? selectedSquad(app) : null;
  const anyone = !exec && !!nextActive(app);
  if (sq) {
    const hero = heroOf(app.db, sq);
    const n = (sq.orders || []).length;
    const max = hero ? apMax(hero, sq, app.db) : 0;
    const ap = sq.ap || 0;
    const fresh = V.chipFor !== sq.id;
    V.chipFor = sq.id;
    const pips = max > 0 && max <= 12
      ? h('span', { class: 'map-chip__pips', 'aria-hidden': 'true' }, Array.from({ length: max }, (_, i) => h('i', { class: i < ap ? 'is-on' : null })))
      : null;
    // AP が無いヒーローを選んだときは、それを先に言う（行き先をタップさせて断らない）
    const sub = ap > 0 ? t(app, 'map.pickHint')
      : anyone ? tx(app, 'map.noApPick', 'AP がありません（ロスターから別のヒーローを）')
        : tx(app, 'map.allDone', '全員の指示が済みました → ターン終了');
    V.chip.appendChild(h('div', {
      class: ['map-chip', 'panel', 'panel--glass', fresh ? 'is-new' : null, ap > 0 ? null : 'is-empty'],
      style: { '--land': landColor(app.db, sq.land) },
    },
    h('span', { class: 'map-chip__face' }, heroThumb(hero, 'map-chip__img', 36)),
    h('span', { class: 'map-chip__text' },
      h('span', { class: 'map-chip__name' }, h('span', { class: 'map-chip__nm' }, hero ? hero.name : sq.id), n ? h('span', { class: 'map-chip__orders num' }, `${t(app, 'map.orders')} ${n}`) : null),
      h('span', { class: 'map-chip__ap num' }, h('b', null, `${t(app, 'map.apLeft')} ${ap}`), pips),
      h('span', { class: 'map-chip__sub' }, sub))));
  } else if (!exec) {
    V.chipFor = null;
    const text = anyone ? t(app, 'map.selectHint') : tx(app, 'map.allDone', '全員の指示が済みました → ターン終了');
    if (!V.guide || !anyone) V.chip.appendChild(h('p', { class: ['map-hint', 'panel', 'panel--glass', anyone ? null : 'is-done'] }, h('span', { class: 'map-hint__dot', 'aria-hidden': 'true' }), text));
  }
  updateGuide(app);

  clear(V.tools);
  if (!exec) {
    V.tools.appendChild(h('button', {
      class: ['map-app__legend-btn', 'panel', 'panel--glass', V.legendOpen ? 'is-on' : null], type: 'button',
      'aria-label': tx(app, 'map.legendTitle', '地図の見かた'), 'aria-expanded': V.legendOpen ? 'true' : 'false',
      onClick: () => toggleLegend(app),
    }, '?'));
  }
  if (ui.debug && !exec) {
    V.tools.appendChild(h('button', {
      class: 'btn-secondary map-tools__btn', type: 'button', 'aria-expanded': ui.menu ? 'true' : 'false',
      onClick: () => { ui.menu = !ui.menu; renderOverlay(app); },
    }, t(app, 'map.view')));
    if (ui.menu) {
      V.tools.appendChild(h('div', { class: 'map-tools__menu' }, [['yield', 'map.viewYield'], ['owner', 'map.viewOwner'], ['fog', 'map.viewFog']].map(([k, key]) =>
        h('button', {
          class: ['map-tools__opt', ui.show[k] ? 'is-on' : null], type: 'button', 'aria-pressed': ui.show[k] ? 'true' : 'false',
          onClick: () => { ui.show[k] = !ui.show[k]; renderOverlay(app); renderSheet(app); requestDraw(); },
        }, t(app, key)))));
    }
  }
  renderDock(app);
}

/**
 * 下の帯: ヒーローの並び（ロスター）と、右端の「ターン終了」（SPEC-112 §7.5.2）。
 * ターン終了は、まだ動けるヒーローがいる間は控えめ（副ボタン + 残りの数）、全員済んだら金の主役になって光る
 */
function renderDock(app) {
  if (!V || !V.dock) return;
  const st = app.state;
  const exec = !!app.ui.executing;
  V.dock.hidden = exec;
  clear(V.roster);
  if (exec) { syncSheetHeight(); return; }
  const cur = app.ui.selectedSquad;
  for (const s of rosterSquads(st)) {
    const hero = heroOf(app.db, s);
    const kind = orderStatus(app, s);
    const max = hero ? apMax(hero, s, app.db) : 0;
    const p = max > 0 ? Math.max(0, Math.min(1, (s.ap || 0) / max)) : 0;
    const on = s.id === cur;
    V.roster.appendChild(h('li', null, h('button', {
      class: ['map-roster__btn', `is-${kind}`, on ? 'is-current' : null, (s.ap || 0) > 0 ? null : 'is-empty'], type: 'button',
      dataset: { squad: s.id, status: kind }, 'aria-current': on ? 'true' : null,
      'aria-label': `${hero ? hero.name : s.id}・${t(app, `home.status.${kind}`)}・AP ${s.ap || 0}/${max}`,
      onClick: () => pickRoster(app, s.id),
    },
    h('span', { class: 'map-roster__ring', style: { '--p': p.toFixed(3), '--land': landColor(app.db, s.land) } }, heroThumb(hero, 'map-roster__img', 32)),
    h('span', { class: `map-roster__mark map-roster__mark--${kind}`, 'aria-hidden': 'true' }),
    h('span', { class: 'map-roster__ap num', 'aria-hidden': 'true' }, String(s.ap || 0)))));
  }
  const left = rosterSquads(st).filter((s) => canAct(app, s)).length;
  const fab = V.fab;
  const ready = left === 0;
  fab.classList.toggle('btn-primary', ready);
  fab.classList.toggle('btn-secondary', !ready);
  fab.classList.toggle('is-ready', ready);
  if (ready) fab.dataset.ripple = 'accent';
  else delete fab.dataset.ripple;
  let badge = fab.querySelector('.map-app__end-badge');
  const label = fmt(tx(app, 'map.leftHeroes', 'あと {n} 人'), { n: left });
  if (!ready) {
    if (!badge) { badge = h('span', { class: 'map-app__end-badge num' }); fab.appendChild(badge); }
    badge.textContent = label;
    fab.title = fmt(tx(app, 'map.idleSquads', '指示待ち {n}'), { n: left });
  } else {
    if (badge) badge.remove();
    fab.removeAttribute('title');
  }
  syncSheetHeight();
}

/** ロスターからヒーローを選ぶ（今のヒーローをもう一度押したら、その部隊へカメラが寄る） */
function pickRoster(app, id) {
  if (app.ui.selectedSquad === id) {
    const sq = app.state.squads[id];
    if (sq && V) {
      const b = viewBand();
      flyTo(app, sq.tile, { zoom: Math.max(app.ui.mapCam.zoom, ZOOM_FOCUS), offsetY: V.ch / 2 - (b.top + b.bottom) / 2 });
    }
    return;
  }
  // 選び直したら開いているシートは閉じる（前のヒーローの経路を残さない）
  if (app.ui.tile != null) { app.ui.tile = null; renderSheet(app); }
  selectSquad(app, id);
}

// ---------- 凡例（右上の「?」） ----------

function toggleLegend(app, open = !V.legendOpen) {
  if (!V) return;
  V.legendOpen = open;
  if (V.legend) {
    const old = V.legend;
    V.legend = null;
    if (motion()) {
      old.classList.add('is-out');
      old.inert = true;
      setTimeout(() => old.remove(), fx.token('--t-ui', 240));
    } else old.remove();
  }
  if (open) {
    V.legend = legendPanel(app);
    V.stage.appendChild(V.legend);
    fx.stagger(V.legend.querySelectorAll('.map-legend__item'), { from: 'left', distance: 8, step: 18, ms: 300, delay: 60 });
  }
  renderOverlay(app);
}

function legendPanel(app) {
  const db = app.db;
  const me = app.state.playerLand;
  const mineCol = landColor(db, me);
  const item = (sw, label) => h('li', { class: 'map-legend__item' }, sw, h('span', null, label));
  const hexSw = (style, extra) => h('span', { class: ['map-legend__hex', extra], style, 'aria-hidden': 'true' });
  const terrains = Object.values(db.terrain || {});
  return h('div', { class: 'map-legend panel panel--glass panel--raised', role: 'dialog', 'aria-label': tx(app, 'map.legendTitle', '地図の見かた') },
    h('header', { class: 'map-legend__head' },
      h('h2', { class: 'map-legend__title' }, tx(app, 'map.legendTitle', '地図の見かた')),
      h('button', { class: 'btn-ghost map-legend__x', type: 'button', 'aria-label': t(app, 'common.close'), onClick: () => toggleLegend(app, false) }, '×')),
    h('h3', { class: 'map-legend__sub' }, tx(app, 'map.legendTerrain', '地形')),
    h('ul', { class: 'map-legend__grid' }, terrains.map((tr) => item(hexSw({ '--sw': muted(tr.color) }), tr.name))),
    h('h3', { class: 'map-legend__sub' }, tx(app, 'map.legendMarks', '記号')),
    h('ul', { class: 'map-legend__list' },
      item(h('span', { class: 'map-legend__unit', style: { '--c': mineCol }, 'aria-hidden': 'true' }), tx(app, 'map.legendMine', '自分の部隊')),
      item(h('span', { class: 'map-legend__unit', style: { '--c': ENEMY_COLOR }, 'aria-hidden': 'true' }), tx(app, 'map.legendOther', 'ほかのランドの部隊')),
      item(hexSw({ '--c': mineCol }, 'is-terr'), tx(app, 'map.legendTerritory', '自ランドの土地（縁取り）')),
      item(h('span', { class: 'map-legend__forts', 'aria-hidden': 'true' }, ['rare', 'epic', 'legendary'].map((r) => hexSw({ '--c': FORT_COLOR[r] }, 'is-fort'))),
        `${tx(app, 'map.legendFort', '砦（枠の色がランク）')}  ${['rare', 'epic', 'legendary'].map((r) => t(app, `fort.${r}`).replace(/砦$/, '')).join(' / ')}`),
      item(hexSw({ '--c': mineCol }, 'is-home'), tx(app, 'map.legendHome', '本拠地')),
      item(h('span', { class: 'map-legend__fac', 'aria-hidden': 'true' }, '街2'), tx(app, 'map.legendFacility', '施設（頭文字とランク）')),
      item(h('span', { class: 'map-legend__fac is-build', 'aria-hidden': 'true' }, '農'), tx(app, 'map.legendBuilding', '建築中（点線）'))),
    h('h3', { class: 'map-legend__sub' }, tx(app, 'map.legendRoute', '移動')),
    h('ul', { class: 'map-legend__list' },
      item(hexSw(null, 'is-reach'), tx(app, 'map.legendReach', '今日届く範囲')),
      item(h('span', { class: 'map-plan__line map-plan__line--today', 'aria-hidden': 'true' }), tx(app, 'map.legendRouteToday', '今日届く')),
      item(h('span', { class: 'map-plan__line map-plan__line--later', 'aria-hidden': 'true' }), tx(app, 'map.legendRouteLater', '翌日以降')),
      item(hexSw(null, 'is-fog'), tx(app, 'map.legendFog', '未探索（霧）'))));
}

// ---------- 初回だけの案内（ナビゲーターが「部隊 → 行き先 → 確定」を一度だけ） ----------
//
// 位置はいつも 1 か所: 画面下の UI（ロスターの帯か、開いていればシート）のすぐ上。地図の上へは跳ばない。
// 段は操作で進む（タップするたびに今の段を選び直す）: 部隊を選ぶ → 行き先をタップ → 「この経路で行く」。
// 経路を確定したら役目を終えて閉じる（二度と出さない）。

function guideWanted(app) {
  return !app.ui.executing && getSetting(GUIDE_KEY, false) !== true;
}

/** 今の操作の段（選んでいない → 'squad'、選んだ → 'dest'、経路が出た → 'go'） */
function guideStage(app) {
  const sel = selectedSquad(app);
  const plan = mv(app).plan;
  if (plan && sel && plan.squad === sel.id) return 'go';
  return sel ? 'dest' : 'squad';
}

function updateGuide(app) {
  if (!V) return;
  if (!V.guide) {
    if (!guideWanted(app) || V.guideClosed) return;
    V.guide = { step: null, el: null, typing: null, timer: 0, tile: null };
    V.guideShown = true;
  }
  if (app.ui.executing) { endGuide(false); return; }
  guideStep(app, guideStage(app));
}

function guideStep(app, step) {
  const g = V && V.guide;
  if (!g || g.step === step) return;
  g.step = step;
  const st = app.state;
  if (step === 'squad') {
    const first = nextActive(app) || idleSquads(st)[0] || mySquads(st)[0];
    g.tile = first ? first.tile : null;
  } else g.tile = null;
  const text = step === 'squad' ? tx(app, 'map.guideSquad2', 'まずは光っている自分の部隊をタップしてね')
    : step === 'dest' ? tx(app, 'map.guideDest2', '次は行き先のタイルをタップ。今日届くところは明るく光っているよ')
      : tx(app, 'map.guideGo', '旗の数字が到着予定日。下の「この経路で行く」で決まり');
  if (!g.el) {
    const pic = h('img', { class: 'map-guide__navi hero-img', src: img(NAVI.point), alt: '', width: 96, height: 128 });
    pic.addEventListener('error', () => pic.remove(), { once: true });
    const bubble = h('p', { class: 'map-guide__text' });
    const ok = h('button', { class: 'btn-ghost map-guide__ok', type: 'button', onClick: () => endGuide(true) }, tx(app, 'map.guideOk', 'わかった'));
    const steps = h('span', { class: 'map-guide__steps', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'));
    g.el = h('aside', { class: 'map-guide', 'aria-live': 'polite' },
      pic,
      h('div', { class: 'map-guide__bubble panel panel--raised' },
        h('span', { class: 'map-guide__head' }, h('span', { class: 'map-guide__name' }, tx(app, 'navi.name', 'マインちゃん')), steps),
        bubble, ok));
    g.pic = pic;
    g.bubble = bubble;
    g.steps = steps;
    V.stage.appendChild(g.el);
  } else if (motion() && g.el.animate) {
    g.el.querySelector('.map-guide__bubble').animate([{ transform: 'scale(.94)' }, { transform: 'scale(1.03)' }, { transform: 'none' }], { duration: fx.token('--t-ui', 240) * 1.4, easing: 'ease-out' });
  }
  const idx = step === 'squad' ? 0 : step === 'dest' ? 1 : 2;
  [...g.steps.children].forEach((n, i) => { n.className = i < idx ? 'is-done' : i === idx ? 'is-on' : ''; });
  // 話している間は口を動かす
  if (g.typing) g.typing.cancel();
  clearInterval(g.timer);
  let f = 0;
  if (motion() && g.pic) {
    g.timer = setInterval(() => { f += 1; if (g.pic) g.pic.src = img(NAVI.talk[f % 2]); }, 140);
  }
  g.typing = fx.typeText(g.bubble, text, { cps: 34, skipOn: g.el });
  g.typing.done.then(() => {
    clearInterval(g.timer);
    if (g.pic && V && V.guide === g) g.pic.src = img(NAVI.point);
  });
  requestDraw();
}

/** 案内を閉じる。record=true なら二度と出さない */
function endGuide(record) {
  if (!V || !V.guide) return;
  const g = V.guide;
  V.guide = null;
  if (record) { setSetting(GUIDE_KEY, true); V.guideClosed = true; }
  clearInterval(g.timer);
  clearTimeout(g.closeTimer);
  if (g.typing) g.typing.cancel();
  if (g.el) {
    if (motion()) {
      g.el.classList.add('is-out');
      g.el.inert = true;
      setTimeout(() => g.el.remove(), fx.token('--t-ui', 240) + 40);
    } else g.el.remove();
  }
  if (record && V.app) renderOverlay(V.app);
  requestDraw();
}

// ------------------------------------------------------------
// 入力（パン・ズーム・タップ）
// ------------------------------------------------------------

function localPoint(e) {
  const r = V.canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function onPointerDown(e) {
  if (!V) return;
  const app = V.app;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  try { V.canvas.setPointerCapture(e.pointerId); } catch { /* 無視 */ }
  const p = localPoint(e);
  V.pointers.set(e.pointerId, p);
  V.camAnim = null;
  if (V.pointers.size === 1) {
    V.drag = { sx: p.x, sy: p.y, cx: app.ui.mapCam.x, cy: app.ui.mapCam.y, moved: false };
    V.pinch = null;
  } else if (V.pointers.size === 2) {
    const [a, b] = [...V.pointers.values()];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    V.pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, z0: app.ui.mapCam.zoom, anchor: screenToWorld(app, mid.x, mid.y) };
    if (V.drag) V.drag.moved = true;
  }
}

function onPointerMove(e) {
  if (!V || !V.pointers.has(e.pointerId)) return;
  const app = V.app;
  const p = localPoint(e);
  V.pointers.set(e.pointerId, p);
  const cam = app.ui.mapCam;
  if (V.pinch && V.pointers.size >= 2) {
    const [a, b] = [...V.pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    cam.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, V.pinch.z0 * d / V.pinch.d0));
    cam.x = V.pinch.anchor.x - (mid.x - V.cw / 2) / cam.zoom;
    cam.y = V.pinch.anchor.y - (mid.y - V.ch / 2) / cam.zoom;
    clampCam(app);
    requestDraw();
    return;
  }
  const dr = V.drag;
  if (!dr) return;
  const dx = p.x - dr.sx;
  const dy = p.y - dr.sy;
  if (!dr.moved && Math.hypot(dx, dy) >= TAP_SLOP) dr.moved = true;
  if (dr.moved) {
    cam.x = dr.cx - dx / cam.zoom;
    cam.y = dr.cy - dy / cam.zoom;
    clampCam(app);
    requestDraw();
  }
}

function onPointerUp(e) {
  if (!V || !V.pointers.has(e.pointerId)) return;
  const app = V.app;
  const p = localPoint(e);
  V.pointers.delete(e.pointerId);
  if (V.pointers.size === 0) {
    const dr = V.drag;
    V.drag = null;
    V.pinch = null;
    if (dr && !dr.moved && e.type === 'pointerup') {
      const tile = screenToTile(app, p.x, p.y);
      if (tile != null) onTap(app, tile);
    }
  } else if (V.pointers.size === 1) {
    // ピンチの片方を離した。残った指でパンを続ける（タップにはしない）
    const [q] = [...V.pointers.values()];
    V.pinch = null;
    V.drag = { sx: q.x, sy: q.y, cx: app.ui.mapCam.x, cy: app.ui.mapCam.y, moved: true };
  }
}

function onWheel(e) {
  if (!V) return;
  e.preventDefault();
  V.camAnim = null;
  const p = localPoint(e);
  const k = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
  zoomAround(V.app, p.x, p.y, V.app.ui.mapCam.zoom * k);
}

function onKey(e) {
  if (!V) return;
  const app = V.app;
  if (e.key === 'Escape' && !app.ui.popup && V.legendOpen) {
    toggleLegend(app, false);
    return;
  }
  if (e.key === 'Escape' && !app.ui.popup && app.ui.tile != null) {
    closeSheet(app);
    return;
  }
  if (e.target !== V.canvas) return;
  const step = 60 / app.ui.mapCam.zoom;
  const cam = app.ui.mapCam;
  let used = true;
  if (e.key === 'ArrowLeft') cam.x -= step;
  else if (e.key === 'ArrowRight') cam.x += step;
  else if (e.key === 'ArrowUp') cam.y -= step;
  else if (e.key === 'ArrowDown') cam.y += step;
  else if (e.key === '+' || e.key === '=') cam.zoom *= 1.2;
  else if (e.key === '-') cam.zoom /= 1.2;
  else if (e.key === 'Enter' || e.key === ' ') {
    const tile = screenToTile(app, V.cw / 2, V.ch / 2);
    if (tile != null) onTap(app, tile);
  } else used = false;
  if (used) {
    e.preventDefault();
    V.camAnim = null;
    clampCam(app);
    requestDraw();
  }
}

function onTap(app, tile) {
  if (V && motion()) V.taps.push({ tile, t0: now() });
  if (V && V.legendOpen) toggleLegend(app, false);
  const sq = !app.ui.executing ? selectedSquad(app) : null;
  // 部隊を選んでいないときに、自分の部隊がいるタイルをタップしたら、指示待ちの部隊（いなければ先頭）を選ぶ。
  // 何体もいるタイル（本拠地など）は、シートの一覧から選び直せる
  if (!sq && !app.ui.executing) {
    const mine = squadsAt(app.state, tile).filter((s) => s.land === app.state.playerLand);
    if (mine.length) {
      const pick = mine.find((s) => s.status !== 'routed' && (s.ap || 0) > 0 && !(s.orders || []).length) || mine[0];
      app.ui.selectedSquad = pick.id;
      mv(app).focusedSquad = pick.id;
      if (V) { V.reach = null; V.selFx = { id: pick.id, t0: now() }; }
      renderOverlay(app);
      openTile(app, tile);
      if (V) {
        const b = viewBand();
        flyTo(app, tile, { zoom: Math.max(app.ui.mapCam.zoom, ZOOM_FOCUS), offsetY: V.ch / 2 - (b.top + b.bottom) / 2 });
      }
      return;
    }
  }
  openTile(app, tile);
}

function resize() {
  if (!V) return;
  const r = V.stage.getBoundingClientRect();
  // 描画の重さを抑えるため、解像度は 2 倍まで（3 倍の端末でも見た目はほぼ変わらない）
  const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
  const cw = Math.max(1, Math.round(r.width));
  const ch = Math.max(1, Math.round(r.height));
  if (cw === V.cw && ch === V.ch && dpr === V.dpr) return;
  V.cw = cw;
  V.ch = ch;
  V.dpr = dpr;
  V.canvas.width = Math.round(cw * dpr);
  V.canvas.height = Math.round(ch * dpr);
  V.canvas.style.width = `${cw}px`;
  V.canvas.style.height = `${ch}px`;
  draw(V.app);
}

// ------------------------------------------------------------
// ビューの約束
// ------------------------------------------------------------

export function render(app) {
  const ui = mv(app);
  if (app.ui.executing) ui.plan = null;
  const canvas = h('canvas', { class: 'map-app__canvas', role: 'img', tabindex: '0', 'aria-label': t(app, 'map.mapLabel'), 'data-ripple': 'off' });
  const chip = h('div', { class: 'map-app__chip' });
  const back = h('button', { class: 'map-back panel panel--glass', type: 'button', 'aria-label': tx(app, 'map.backLabel', '戻る（1 つ前へ）'), onClick: () => goBack(app) },
    h('span', { class: 'map-back__chev', 'aria-hidden': 'true' }), h('span', { class: 'map-back__label' }, tx(app, 'common.back', '戻る')));
  const top = h('div', { class: 'map-app__top' }, back, chip);
  const tools = h('div', { class: 'map-app__tools' });
  const fab = h('button', { class: 'btn-secondary map-app__end', type: 'button', onClick: () => endTurn() }, h('span', { class: 'map-app__end-label' }, t(app, 'map.endTurn')));
  const roster = h('ol', { class: 'map-roster', 'aria-label': tx(app, 'chat.roster', 'ヒーローの並び') });
  const dock = h('div', { class: 'map-dock panel panel--glass' }, roster, fab);
  const vignette = h('div', { class: 'map-app__vignette', 'aria-hidden': 'true' });
  const stage = h('div', { class: 'map-app__stage' }, canvas, vignette, top, tools, dock);
  const sheet = h('section', { class: 'map-sheet panel panel--glass', 'aria-labelledby': 'map-sheet-title', hidden: true });
  return h('section', { class: 'map-app', dataset: { executing: app.ui.executing ? '1' : '0' } }, stage, sheet);
}

export function mount(app, el) {
  if (V) unmount(app);
  if (!app.state || !el) return;
  const stage = el.querySelector('.map-app__stage');
  const canvas = el.querySelector('.map-app__canvas');
  const root = el.querySelector('.map-app') || el;
  V = {
    app, el: root, stage, canvas,
    ctx: canvas.getContext('2d'),
    sheet: el.querySelector('.map-sheet'),
    chip: el.querySelector('.map-app__chip'),
    topEl: el.querySelector('.map-app__top'),
    back: el.querySelector('.map-back'),
    tools: el.querySelector('.map-app__tools'),
    fab: el.querySelector('.map-app__end'),
    dock: el.querySelector('.map-dock'),
    roster: el.querySelector('.map-roster'),
    cw: 0, ch: 0, dpr: 0, raf: 0, dirty: true, lastDraw: 0, sc: null, sctx: null, staticKey: '', staticDirty: true,
    pointers: new Map(), drag: null, pinch: null,
    anims: new Map(), lunges: new Map(), floats: [], taps: [], shake: null, camAnim: null, reach: null,
    selFx: null, pathFx: null, chipFor: null, legend: null, legendOpen: false,
    guide: null, guideShown: false, guideClosed: false, lastHit: null, cutins: Promise.resolve(),
    claims: [], offs: [], ro: null,
    timers: new Set(), holds: new Map(), flagFx: [], camHold: 0, beatEnd: 0, falls: new Map(), exec: null,
  };
  const ui = mv(app);
  // 開いたとき、選んでいるヒーローが動けない（AP 0）か誰も選んでいなければ、ロスターの順で動けるヒーローを選び直す
  // （AP 0 のヒーローに「行き先をタップ」と案内して、引いた経路で断る、を起こさない。SPEC-112 E）
  if (!app.ui.executing) {
    const cur = selectedSquad(app);
    if (!cur || (cur.ap || 0) <= 0) {
      const nx = nextActive(app, cur ? cur.id : null);
      if (nx) {
        app.ui.selectedSquad = nx.id;
        V.selFx = { id: nx.id, t0: now() };
        if (app.ui.tile != null && cur && app.ui.tile === cur.tile) app.ui.tile = null;
      }
    }
  }
  // Chat などから部隊を選んで来たら、その部隊へ寄る（タイルの指定があればそちらを優先）
  const sq = selectedSquad(app);
  if (sq && ui.focusedSquad !== sq.id && app.ui.tile == null) {
    ui.focusedSquad = sq.id;
    centerOn(app, sq.tile);
  }
  if (app.ui.executing) {
    // 実行フェーズは自分の部隊が見える所から（寄りすぎていれば引く）
    app.ui.tile = null;
    const mine = Object.values(app.state.squads).find((x) => x.land === app.state.playerLand);
    const home = app.state.lands[app.state.playerLand] && app.state.lands[app.state.playerLand].home;
    const tile = mine ? mine.tile : home;
    if (tile != null) centerOn(app, tile);
    // 戦闘の数字とエフェクトが読める寄り（引きすぎ・寄りすぎを直す）
    app.ui.mapCam.zoom = Math.min(1.2, Math.max(0.95, app.ui.mapCam.zoom || 1));
    // 進み具合（execbar は mount の後に描かれるので、次の番で差す）
    V.exec = { n: 0, total: estimateBeats(app) };
    later(() => renderProgress(), 0);
  }
  clampCam(app);

  V.offs.push(on(canvas, 'pointerdown', onPointerDown));
  V.offs.push(on(canvas, 'pointermove', onPointerMove));
  V.offs.push(on(canvas, 'pointerup', onPointerUp));
  V.offs.push(on(canvas, 'pointercancel', onPointerUp));
  V.offs.push(on(canvas, 'wheel', onWheel, { passive: false }));
  V.offs.push(on(canvas, 'contextmenu', (e) => e.preventDefault()));
  V.offs.push(on(document, 'keydown', onKey));
  V.offs.push(on(document, 'visibilitychange', () => requestDraw()));
  V.offs.push(fx.onMotionChange(() => requestDraw()));
  if (typeof ResizeObserver !== 'undefined') {
    V.ro = new ResizeObserver(() => { resize(); syncSheetHeight(); });
    V.ro.observe(stage);
    if (V.sheet) V.ro.observe(V.sheet);
    if (V.dock) V.ro.observe(V.dock);
  }
  V.offs.push(on(window, 'resize', resize));

  if (app.ui.tile != null && !app.ui.executing) {
    const s = selectedSquad(app);
    ui.plan = s && app.ui.tile !== projectedTile(s) ? makePlan(app, s, app.ui.tile) : null;
    notePlan(ui.plan);
  }
  renderOverlay(app);
  renderSheet(app);
  resize();
  requestDraw();
}

export function unmount() {
  if (!V) return;
  // 案内を一度見せたら、途中で離れても次からは出さない（「一度だけ」）
  if (V.guideShown) setSetting(GUIDE_KEY, true);
  if (V.guide) {
    clearInterval(V.guide.timer);
    clearTimeout(V.guide.closeTimer);
    if (V.guide.typing) V.guide.typing.cancel();
  }
  if (V.raf) cancelAnimationFrame(V.raf);
  for (const id of V.timers) clearTimeout(id);
  for (const off of V.offs) { try { off(); } catch { /* 無視 */ } }
  if (V.ro) V.ro.disconnect();
  V = null;
}

/** 陥落のカットイン（続けて落ちたら順に）。攻めたヒーローの絵が文字の手前に重なる */
function fallCutin(opts) {
  if (!V) return;
  V.cutins = V.cutins.then(() => (V ? fx.cutin(opts) : null)).catch(() => {});
}

// ---------- 実行フェーズの進み具合（execbar に「3/12」とバー） ----------

/** 残りの拍の数の見込み（まだ残っている指示から数える。移動は 1 マスで 1 拍、日の終わりに 1 拍） */
function estimateBeats(app) {
  const st = app.state;
  const exp = exploredSet(st);
  let n = 0;
  for (const s of Object.values(st.squads || {})) {
    const mine = s.land === st.playerLand;
    for (const o of s.orders || []) {
      if (o.type === 'move' && Array.isArray(o.path)) {
        n += mine ? o.path.length : o.path.filter((i) => exp.has(i)).length;
      } else if (mine || exp.has(s.tile)) n += o.type === 'attack' ? 2 : 1;
    }
  }
  return Math.max(1, n + 1);
}

function noteBeat(app) {
  if (!V) return;
  if (!V.exec) V.exec = { n: 0, total: 1 };
  V.exec.n += 1;
  // エンジンは指示を消化しながら進むので、残っている指示から毎回数え直す（見えない拍のぶん、少しずつ締まる）
  V.exec.total = V.exec.n + estimateBeats(app);
  renderProgress();
}

/** execbar（phone.js が描く）の中に、進み具合を差す。描き直されて消えていたら差し直す */
function renderProgress(done = false) {
  if (!V || !V.exec || typeof document === 'undefined') return;
  const bar = document.querySelector('.phone__execbar .execbar');
  if (!bar) return;
  let el = bar.querySelector('.map-exec');
  if (!el) {
    el = h('span', { class: 'map-exec', role: 'progressbar', 'aria-valuemin': '0' },
      h('span', { class: 'map-exec__track', 'aria-hidden': 'true' }, h('i', { class: 'map-exec__fill' })),
      h('b', { class: 'map-exec__n num' }));
    const label = bar.querySelector('.execbar__label');
    if (label && label.nextSibling) bar.insertBefore(el, label.nextSibling);
    else bar.appendChild(el);
  }
  const n = done ? V.exec.total : Math.min(V.exec.n, V.exec.total);
  el.setAttribute('aria-valuemax', String(V.exec.total));
  el.setAttribute('aria-valuenow', String(n));
  el.querySelector('.map-exec__fill').style.transform = `scaleX(${(n / V.exec.total).toFixed(3)})`;
  el.querySelector('.map-exec__n').textContent = `${n}/${V.exec.total}`;
}

/** 2 タイルの中点（ワールド座標。東西ループは近い写しで） */
function midWorld(st, a, b) {
  const pa = tileWorld(st, a);
  const pb = tileWorld(st, b);
  const P = period(st);
  let dx = pb.x - pa.x;
  dx = ((dx % P) + P * 1.5) % P - P / 2;
  return { x: pa.x + dx / 2, y: (pa.y + pb.y) / 2 };
}

/** カメラをワールド座標へ寄せる（ズームは変えない） */
function flyToWorld(app, w, dur) {
  const cam = app.ui.mapCam;
  const P = period(app.state);
  let dx = w.x - cam.x;
  dx = ((dx % P) + P * 1.5) % P - P / 2;
  if (!motion()) { cam.x += dx; cam.y = w.y; clampCam(app); requestDraw(); return; }
  V.camAnim = { fx: cam.x, fy: cam.y, fz: cam.zoom, tx: cam.x + dx, ty: w.y, tz: cam.zoom, t0: now(), dur };
  requestDraw();
}

/**
 * 戦闘の 1 拍（SPEC-112 §3）。時間の並び:
 *   0      カメラが攻撃側と守備側の中点へ寄る（400ms）
 *   +400   スキルがあれば、数字の 28px 上にスキル名の帯（600ms。数字と同時に出さない）
 *   その後 攻撃側が前に出る → 命中: エフェクトのスプライト + ダメージの数字が弾む（読めるまで 900ms）
 *   陥落   砦の旗の色が変わる（300ms）→ カットイン（fort_fallen のイベントが来たら、この時刻に合わせて出す）
 * main.js は 350ms ごとに次のイベントを渡してくるので、前の拍を見せ終えるまでは次の戦闘を待たせ（最大 1.5 秒）、
 * その間はカメラを移動に付いていかせない（camHold）。
 */
function playBattle(app, ev, tm) {
  const st = app.state;
  const mo = motion();
  const z = app.ui.mapCam.zoom;
  const attacker = st.squads[ev.attacker];
  const at = tileWorld(st, ev.at);
  const from = attacker && attacker.tile != null ? attacker.tile : null;
  const d = mo ? Math.min(1500, Math.max(0, V.beatEnd - tm)) : 0;
  const camMs = mo ? BATTLE_CAM_MS : 0;
  const skillMs = mo && ev.skill && ev.skill.name ? SKILL_LABEL_MS : 0;
  const hitT = d + camMs + skillMs + (mo ? 130 : 0);
  // 1. カメラ（前の拍が終わってから）
  const fly = () => { if (V) flyToWorld(app, from != null ? midWorld(st, from, ev.at) : at, camMs || 1); };
  if (d > 0) later(fly, d); else fly();
  // 2. スキル名の帯（数字と同時に出さない）
  // （動きを減らすときは待たずに数字と一緒に出す。帯は数字の 28px 上なので重ならない）
  if (ev.skill && ev.skill.name) V.floats.push({ kind: 'label', wx: at.x, wy: at.y, text: ev.skill.name, t0: tm + d + camMs, dur: skillMs || 1000, dy: 0 });
  // 3. 攻撃側が少し前に出てから戻る
  if (attacker && mo && from !== ev.at) {
    const a = tileWorld(st, from);
    const P = period(st);
    let dx = at.x - a.x;
    dx = ((dx % P) + P * 1.5) % P - P / 2;
    const len = Math.hypot(dx, at.y - a.y) || 1;
    later(() => { if (V) { V.lunges.set(attacker.id, { ux: dx / len, uy: (at.y - a.y) / len, t0: now(), dur: 360 }); requestDraw(); } }, hitT - 130);
  }
  // 4. 命中: スプライト・数字・揺れ
  const add = (wx, wy, text, color, scale, dy, delay, shine) => V.floats.push({ wx, wy, text, color, scale, dy, t0: tm + delay, dur: 1150, shine });
  if (ev.ambush) add(at.x, at.y, t(app, 'execute.ambush'), '#ffd34d', 0.5, -BASE * z * 0.7, hitT, false);
  add(at.x, at.y, ev.evaded ? t(app, 'execute.evaded') : `-${ev.dmg}`, ev.evaded ? '#6fd8e8' : '#ff6464', ev.evaded ? 0.55 : 0.75, 0, hitT, !ev.evaded);
  if (!ev.evaded) {
    later(() => {
      if (!V) return;
      const pt = tileClient(app, ev.at);
      const size = Math.max(120, Math.round(BASE * app.ui.mapCam.zoom * 3.4));
      if (pt) fx.spriteOnce(ev.skill && ev.skill.name ? '02_area_damage' : '01_single_damage', clampClient(pt, size * 0.3), { size });
      if (mo) V.shake = { t0: now(), dur: 220, amp: ev.result ? 5 : 2.5 };
      requestDraw();
    }, hitT);
  }
  if (ev.counter && attacker) {
    const ap = tileWorld(st, from);
    add(ap.x, ap.y, ev.counter.evaded ? t(app, 'execute.evaded') : `-${ev.counter.dmg}`, ev.counter.evaded ? '#6fd8e8' : '#ff6464', 0.55, 0, hitT + 260, !ev.counter.evaded);
    if (!ev.counter.evaded) {
      later(() => {
        if (!V) return;
        const pt = tileClient(app, from);
        if (pt) fx.spriteOnce('01_single_damage', clampClient(pt, 30), { size: Math.max(96, Math.round(BASE * app.ui.mapCam.zoom * 2.6)) });
      }, hitT + 260);
    }
  }
  let endT = hitT + (mo ? HIT_READ_MS : 0);
  let beat = hitT + (mo ? 520 : 0);
  // 5. 陥落: 旗の色を、数字が読めてから変える。そのあとカットイン
  const fall = (ev.followups || []).find((e) => e.t === 'fort_fallen' || e.t === 'home_fallen');
  if (fall) {
    const flagT = endT;
    const tile = fall.t === 'fort_fallen' ? (st.forts[fall.fort] && st.forts[fall.fort].tile) : (st.lands[fall.land] && st.lands[fall.land].home);
    if (fall.t === 'fort_fallen' && st.forts[fall.fort] && mo) {
      // 今の state はもう落ちた後なので、旗の色が変わる時刻まで前の持ち主で描く
      V.holds.set(fall.fort, { fort: fall.fort, tile, owner: fall.from || ENEMY, tileOwner: fall.from === ENEMY ? (st.map.tiles[tile] || {}).owner : fall.from, until: tm + flagT });
      V.staticDirty = true;
    }
    later(() => {
      if (!V) return;
      V.holds.delete(fall.fort);
      V.staticDirty = true;
      if (tile != null) V.flagFx.push({ tile, color: landColor(app.db, fall.by), t0: now(), dur: FLAG_MS + 200 });
      if (mo) V.shake = { t0: now(), dur: 420, amp: 7 };
      const pt = tile != null ? tileClient(app, tile) : null;
      if (pt) fx.spriteOnce('04_buff', clampClient(pt, 40), { size: Math.max(140, Math.round(BASE * app.ui.mapCam.zoom * 4)) });
      requestDraw();
    }, flagT);
    endT = flagT + (mo ? FLAG_MS : 0);
    beat = endT + (mo ? 900 : 0);
    V.falls.set(fallKey(fall), { t: tm + endT, attacker: ev.attacker });
  }
  V.camHold = Math.max(V.camHold, tm + endT);
  V.beatEnd = Math.max(V.beatEnd, tm + beat);
}

function fallKey(e) {
  return e.t === 'fort_fallen' ? `f:${e.fort}` : `h:${e.land}`;
}

/** スプライトの中心を、端末の画面の内側へ寄せる（半分切れないように） */
function clampClient(pt, pad) {
  if (!V || !V.canvas) return pt;
  const r = V.canvas.getBoundingClientRect();
  const m = FLOAT_MARGIN + pad;
  return { x: Math.min(r.right - m, Math.max(r.left + m, pt.x)), y: Math.min(r.bottom - m, Math.max(r.top + m, pt.y)) };
}

/** 陥落の知らせ（帯 / カットイン）。戦闘の演出の後に出す */
function showFall(app, ev) {
  if (!V) return;
  const st = app.state;
  const me = st.playerLand;
  const n = noticesFrom(st, app.db, [ev]);
  const hit = V.lastHit;
  // 攻めたヒーロー（その陥落を起こした戦闘の攻撃側。無ければ攻めたランドの部隊）
  const plan = V.falls.get(fallKey(ev));
  let sq = plan && st.squads[plan.attacker] ? st.squads[plan.attacker] : (hit && hit.land === ev.by ? st.squads[hit.attacker] : null);
  if (!sq) sq = Object.values(st.squads || {}).find((s) => s.land === ev.by) || null;
  const hero = heroOf(app.db, sq);
  let title;
  let text;
  if (ev.t === 'fort_fallen') {
    const f = st.forts[ev.fort];
    const fname = f ? (f.name || t(app, `fort.${f.rank}`)) : t(app, 'map.fort');
    title = tx(app, 'map.fortFallen', '砦 陥落');
    // 誰が落としたかを文で言う（絵がエネミーかヒーローか迷わないように）
    text = hero ? fmt(tx(app, 'map.fellBy', '{hero}が{target}を落としました'), { hero: hero.name, target: fname })
      : (n[0] ? n[0].text : ev.by === me ? `${fname}を落としました` : `${landName(app, ev.by)}が${fname}を落としました`);
  } else {
    title = tx(app, 'map.homeFallen', '本拠地 陥落');
    text = n[0] ? n[0].text : t(app, 'end.home_fallen');
  }
  const side = ev.by === me ? 'ally' : 'opponent';
  const major = ev.by === me || ev.from === me || ev.land === me;
  if (!hero || !major) band(text, { kind: side === 'ally' ? 'good' : 'bad', slim: !major, ms: major ? undefined : 900 });
  else fallCutin({ image: hero.image, title, sub: text, side, se: null, major: true });
}

/** 実行フェーズの 1 歩（SPEC-111 §8、SPEC-112 §3） */
export function onEvent(app, ev) {
  if (!V || !ev) return;
  const st = app.state;
  const tm = now();
  const mo = motion();
  const step = (mo ? STEP_MS : 120) || 350;
  const z = app.ui.mapCam.zoom;
  noteBeat(app);
  switch (ev.t) {
    case 'move': {
      if (mo) V.anims.set(ev.squad, { from: ev.from, to: ev.to, t0: tm, dur: step * 0.85 });
      const sq = st.squads[ev.squad];
      // 自分の部隊の動きにカメラが付いていく（戦闘の拍を見せている間は動かさない）
      if (sq && sq.land === st.playerLand && tm >= V.camHold) flyToWorld(app, tileWorld(st, ev.to), mo ? step * 0.9 : 1);
      break;
    }
    case 'battle': {
      const attacker = st.squads[ev.attacker];
      playBattle(app, ev, tm);
      V.lastHit = { attacker: ev.attacker, land: attacker ? attacker.land : null, at: ev.at, result: ev.result || null };
      break;
    }
    default:
      if (ev.t === 'fort_fallen' || ev.t === 'home_fallen') {
        // 戦闘の演出（数字 → 旗の色）が終わってから知らせる。戦闘が見えていなかったらすぐ
        const plan = V.falls.get(fallKey(ev));
        const wait = plan ? Math.max(0, plan.t - tm) : 0;
        if (!plan) {
          const tile = ev.t === 'fort_fallen' && st.forts[ev.fort] ? st.forts[ev.fort].tile : (st.lands[ev.land] && st.lands[ev.land].home);
          if (mo) V.shake = { t0: tm, dur: 420, amp: 7 };
          const pt = tile != null ? tileClient(app, tile) : null;
          if (pt) fx.spriteOnce('04_buff', clampClient(pt, 40), { size: Math.max(140, Math.round(BASE * z * 4)) });
        }
        // 帯で済む知らせは同期で出す（main.js が積んだカットインの印を取り消すため）。カットインは後で
        const me = st.playerLand;
        const major = ev.by === me || ev.from === me || ev.land === me;
        if (wait <= 0 || !major) showFall(app, ev);
        else later(() => showFall(app, ev), wait);
      } else if (ev.t === 'clear') {
        band(noticesFrom(st, app.db, [ev])[0]?.text || t(app, 'end.clear'), { kind: 'good' });
      } else if (ev.t === 'claim') {
        if (ev.land === st.playerLand) {
          V.claims.push(ev);
          const n = noticesFrom(st, app.db, V.claims);
          if (n[0]) toast(n[0].text, { key: 'ev-claim', kind: 'good' });
          if (typeof ev.tile === 'number') V.taps.push({ tile: ev.tile, t0: tm });
        }
      } else if (ev.t === 'yield') {
        if (ev.land === st.playerLand && ev.res) {
          const r = ev.res;
          toast(`${t(app, 'map.yieldToast')}  ${t(app, 'res.food')} +${r.food || 0}  ${t(app, 'res.gum')} +${r.gum || 0}  ${t(app, 'res.mat')} +${r.mat || 0}`, { key: 'ev-yield', kind: 'good', icon: 'Image/Icons/gum.png' });
        }
      } else if (ev.t === 'build_start') {
        const sq = st.squads[ev.squad];
        if (sq && sq.land === st.playerLand) {
          const fac = app.db.facilities[ev.kind];
          toast(say(app.db, heroOf(app.db, sq), 'order.build.ack', { kind: fac ? fac.name : ev.kind, days: ev.days }), { key: 'ev-build', kind: 'info' });
        }
      } else if (ev.t === 'rest') {
        const sq = st.squads[ev.squad];
        if (sq && sq.land === st.playerLand) {
          toast(`${heroOf(app.db, sq)?.name || ''} ${t(app, 'cmd.rest')} +${ev.amount || 0}`, { key: 'ev-rest', kind: 'good' });
          const pt = tileClient(app, sq.tile);
          if (pt) fx.spriteOnce('03_heal_resurrection', clampClient(pt, 30), { size: Math.max(100, Math.round(BASE * z * 2.6)) });
        }
      } else {
        const n = noticesFrom(st, app.db, [ev]);
        if (n[0]) toast(n[0].text, { key: `ev-${ev.t}` });
      }
      break;
  }
  requestDraw();
}

export function onExecuteEnd() {
  if (!V) return;
  renderProgress(true);
  for (const id of V.timers) clearTimeout(id);
  V.timers.clear();
  V.holds.clear();
  V.flagFx = [];
  V.falls.clear();
  V.camHold = 0;
  V.beatEnd = 0;
  V.exec = null;
  V.staticDirty = true;
  V.anims.clear();
  V.lunges.clear();
  V.floats = [];
  V.taps = [];
  V.shake = null;
  V.camAnim = null;
  V.claims = [];
  V.reach = null;
  V.lastHit = null;
  requestDraw();
}
