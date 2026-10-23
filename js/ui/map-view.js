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
import { endTurn, STEP_MS } from '../main.js';

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
/** 経路の線が出発地から目的地へ伸びきるまで */
const PATH_MS = 420;
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

const BAND_EVENTS = new Set(['fort_fallen', 'home_fallen', 'clear']);

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

/** シートや上の札に隠れていない、地図の見えている帯（画面座標） */
function viewBand() {
  const ge = V.guide && V.guide.el && V.el.classList.contains('has-sheet') ? V.guide.el : null;
  const top = ge ? Math.max(64, ge.offsetTop + ge.offsetHeight + 4) : 64;
  const sheetH = V.sheet && !V.sheet.hidden ? V.sheet.getBoundingClientRect().height : 0;
  return { top, bottom: Math.max(top + 40, V.ch - sheetH - 12) };
}

/**
 * タイルが画面の端やシートに隠れていれば寄せる。from を渡すと、出発地と行き先の両方が収まるように寄せる
 * （収まらなければ行き先を優先）
 */
function ensureVisible(app, tile, from = null) {
  if (!V || tile == null) return;
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
  if (inside(s) && (!q || inside(q))) return;
  const mid = (b.top + b.bottom) / 2;
  const dur = fx.token('--t-flip', 380);
  if (q && Math.abs(q.x - s.x) < V.cw - m * 2 && Math.abs(q.y - s.y) < b.bottom - b.top - m) {
    // 2 点の真ん中へ（ワールド座標で）
    const wx = (q.x + s.x) / 2;
    const wy = (q.y + s.y) / 2;
    const w = screenToWorld(app, wx, wy);
    const cam = app.ui.mapCam;
    if (!motion()) { cam.x = w.x; cam.y = w.y + (V.ch / 2 - mid) / cam.zoom; clampCam(app); requestDraw(); return; }
    V.camAnim = { fx: cam.x, fy: cam.y, fz: cam.zoom, tx: w.x, ty: w.y + (V.ch / 2 - mid) / cam.zoom, tz: cam.zoom, t0: now(), dur };
    requestDraw();
    return;
  }
  flyTo(app, tile, { offsetY: V.ch / 2 - mid, dur });
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
    || (V.pathFx && tm - V.pathFx.t0 < PATH_MS + 500)
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
  // 2. 占領色（自ランドは薄く塗って縁取りで見せる）
  const ownerOf = (i) => (seen(i) && tiles[i] ? tiles[i].owner : null);
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
    if (fort.owner !== ENEMY) {
      ctx.fillStyle = landColor(db, fort.owner);
      ctx.beginPath();
      ctx.arc(c.x + s * 0.6, c.y - s * 0.55, Math.max(3, s * 0.16), 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
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

/** 裏の canvas を描き直すかどうかの鍵（カメラ・大きさ・選択・到達範囲・表示の切り替え） */
function staticKey(app, tm) {
  const cam = app.ui.mapCam;
  const sel = !app.ui.executing ? selectedSquad(app) : null;
  const fading = sel && V.selFx && motion() && tm - V.selFx.t0 < 260;
  const show = mv(app).show;
  return [cam.x.toFixed(2), cam.y.toFixed(2), cam.zoom.toFixed(4), V.cw, V.ch, V.dpr,
    sel ? sel.id : '', V.reach ? V.reach.key : '', fading ? tm : '', show.fog, show.owner, show.yield].join('|');
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
    // 選択中の部隊がいれば一番手前に
    list.sort((a, b) => ((a.land === me) - (b.land === me)) || ((a.id === app.ui.selectedSquad) - (b.id === app.ui.selectedSquad)));
    const n = Math.min(list.length, 3);
    // 砦・本拠地のタイルでは、絵を隠さないように下へ寄せて小さく
    const crowded = !!tiles[c.tile].fort || !!homeAt(st, c.tile);
    const ss = crowded ? s * 0.7 : s;
    const yy = crowded ? c.y + s * 0.42 : c.y - s * 0.05;
    for (let k = 0; k < n; k++) {
      const off = (k - (n - 1) / 2) * ss * 0.42;
      drawSquad(app, list[list.length - n + k], c.x + off, yy, ss, tm, true);
    }
    if (list.length > 1 && s >= 12) {
      const fs = Math.max(9, s * 0.34);
      ctx.font = `800 ${fs}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = INK;
      ctx.beginPath();
      ctx.arc(c.x + s * 0.62, c.y + s * 0.5, fs * 0.72, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.25)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#f2ecfa';
      ctx.fillText(String(list.length), c.x + s * 0.62, c.y + s * 0.52);
    }
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
  // 浮く文字（ダメージ・奇襲・回避）。出る瞬間に弾んでから昇る
  for (const f of V.floats) {
    const age = tm - f.t0;
    if (age < 0) continue;
    const k = Math.min(1, age / f.dur);
    const p = toScreen(app, f.wx, f.wy);
    const mo = motion();
    const pop = !mo ? 1 : k < 0.1 ? 0.4 + (k / 0.1) * 1.05 : k < 0.24 ? 1.45 - ((k - 0.1) / 0.14) * 0.45 : 1;
    const rise = !mo ? 0 : Math.max(0, k - 0.24) * s * 1.1;
    ctx.globalAlpha = k > 0.75 ? (1 - k) / 0.25 : 1;
    const size = Math.max(13, s * f.scale) * pop;
    ctx.font = `900 ${size}px "Hiragino Sans","Noto Sans JP",sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const y = p.y - s * 0.6 - rise + f.dy;
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(3, size * 0.2);
    ctx.strokeStyle = 'rgba(10,8,16,.92)';
    ctx.strokeText(f.text, p.x, y);
    ctx.fillStyle = f.color;
    ctx.fillText(f.text, p.x, y);
    if (f.shine) {
      ctx.fillStyle = 'rgba(255,255,255,.55)';
      ctx.save();
      ctx.beginPath();
      ctx.rect(p.x - size * 3, y - size * 0.6, size * 6, size * 0.45);
      ctx.clip();
      ctx.fillText(f.text, p.x, y);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }
}

function drawSquad(app, sq, x, y, s, tm, idle) {
  const ctx = V.ctx;
  const st = app.state;
  const mine = sq.land === st.playerLand;
  const selected = app.ui.selectedSquad === sq.id && !app.ui.executing;
  const size = Math.max(14, s * 1.15) * (selected ? 1.06 : 1);
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

/** 経路のプレビュー: 出発地から線が伸びる。今日届く分は金の実線、翌日以降は点線。日の変わり目に番号、終点に到着予定のピン */
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
  const t0 = V.pathFx ? V.pathFx.t0 : 0;
  const k = mo ? Math.min(1, (tm - t0) / PATH_MS) : 1;
  const grow = 1 - Math.pow(1 - k, 3);
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
  const fs = Math.max(9, s * 0.3);
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
  // 到着予定のピン（落ちてきて弾む）
  const end = pts[pts.length - 1];
  const pk = mo ? Math.min(1, (tm - t0 - PATH_MS) / 360) : 1;
  const drop = mo ? (1 - (1 + 2.6 * Math.pow(pk - 1, 3) + 1.6 * Math.pow(pk - 1, 2))) * s * 0.9 : 0;
  ctx.fillStyle = 'rgba(0,0,0,.4)';
  ctx.beginPath();
  ctx.ellipse(end.x, end.y, Math.max(4, s * 0.22) * (0.6 + 0.4 * pk), Math.max(2, s * 0.08), 0, 0, Math.PI * 2);
  ctx.fill();
  const days = plan.days != null ? plan.days : dayOf[dayOf.length - 1];
  const label = fmt(t(app, 'map.daysUnit'), { n: days }).replace(/\s+/g, '');
  const pfs = Math.max(10, s * 0.36);
  ctx.font = `900 ${pfs}px "Hiragino Sans","Noto Sans JP",sans-serif`;
  const tw = ctx.measureText(label).width;
  const bw = tw + pfs * 0.9;
  const bh = pfs * 1.5;
  const by = end.y - s * 0.55 - bh - drop;
  const col = days <= 1 ? ACCENT : LATER;
  // 吹き出しの足
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.moveTo(end.x - pfs * 0.35, by + bh - 1);
  ctx.lineTo(end.x + pfs * 0.35, by + bh - 1);
  ctx.lineTo(end.x, end.y - s * 0.1 - drop);
  ctx.closePath();
  ctx.fill();
  roundRect(ctx, end.x - bw / 2, by, bw, bh, bh / 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.5)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(end.x - bw / 2 + bh / 2, by + 1.5);
  ctx.lineTo(end.x + bw / 2 - bh / 2, by + 1.5);
  ctx.stroke();
  ctx.fillStyle = INK;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, end.x, by + bh / 2 + 0.5);
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
  const k = mo && V.pathFx ? Math.min(1, (tm - V.pathFx.t0) / PATH_MS) : 1;
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
  if (key && (!V.pathFx || V.pathFx.key !== key)) V.pathFx = { key, t0: now() };
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
  if (V && V.guide) guideStep(app, 'done');
  renderSheet(app);
  renderOverlay(app);
  requestDraw();
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
  requestDraw();
  requestAnimationFrame(() => ensureVisible(app, tile, ui.plan ? ui.plan.from : null));
}

function closeSheet(app) {
  app.ui.tile = null;
  mv(app).plan = null;
  notePlan(null);
  renderSheet(app);
  requestDraw();
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
      note ? h('p', { class: 'map-plan__note' }, note) : null,
      h('button', { class: ['btn-primary', 'map-plan__go', 'map-plan__go--attack'], type: 'button', disabled: !plan.ok, onClick: () => applyPlan(app) }, label));
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
    plan.ok ? null : h('p', { class: 'map-plan__note' }, rejectText(app, sq, plan.reason)),
    h('button', { class: 'btn-primary map-plan__go', type: 'button', disabled: !plan.ok, onClick: () => applyPlan(app) }, t(app, 'map.go')));
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

/** シートの高さを CSS へ（ターン終了ボタンと案内をシートの上へ逃がす） */
function syncSheetHeight() {
  if (!V) return;
  const hgt = V.sheet && !V.sheet.hidden ? V.sheet.offsetHeight : 0;
  V.el.style.setProperty('--sheet-h', `${hgt}px`);
  V.el.classList.toggle('has-sheet', hgt > 0);
}

function renderOverlay(app) {
  if (!V) return;
  const ui = mv(app);
  const st = app.state;
  clear(V.chip);
  updateGuide(app);
  const sq = !app.ui.executing ? selectedSquad(app) : null;
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
    V.chip.appendChild(h('div', { class: ['map-chip', 'panel', 'panel--glass', fresh ? 'is-new' : null], style: { '--land': landColor(app.db, sq.land) } },
      h('span', { class: 'map-chip__face' }, heroThumb(hero, 'map-chip__img', 36)),
      h('span', { class: 'map-chip__text' },
        h('span', { class: 'map-chip__name' }, hero ? hero.name : sq.id, n ? h('span', { class: 'map-chip__orders num' }, `${t(app, 'map.orders')} ${n}`) : null),
        h('span', { class: 'map-chip__ap num' }, h('b', null, `${t(app, 'map.apLeft')} ${ap}`), pips),
        h('span', { class: 'map-chip__sub' }, t(app, 'map.pickHint'))),
      h('button', { class: 'btn-ghost map-chip__x', type: 'button', 'aria-label': t(app, 'map.deselect'), onClick: () => selectSquad(app, null) }, '×')));
  } else if (!app.ui.executing) {
    V.chipFor = null;
    if (!V.guide) V.chip.appendChild(h('p', { class: 'map-hint panel panel--glass' }, h('span', { class: 'map-hint__dot', 'aria-hidden': 'true' }), t(app, 'map.selectHint')));
  }

  clear(V.tools);
  if (!app.ui.executing) {
    V.tools.appendChild(h('button', {
      class: ['map-app__legend-btn', 'panel', 'panel--glass', V.legendOpen ? 'is-on' : null], type: 'button',
      'aria-label': tx(app, 'map.legendTitle', '地図の見かた'), 'aria-expanded': V.legendOpen ? 'true' : 'false',
      onClick: () => toggleLegend(app),
    }, '?'));
  }
  if (ui.debug && !app.ui.executing) {
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
  // ターン終了: 指示待ちの部隊の数。全員に指示を出したら金に光る
  V.fab.hidden = !!app.ui.executing;
  if (!app.ui.executing) {
    const idle = idleSquads(st).length;
    V.fab.classList.toggle('is-ready', idle === 0);
    let badge = V.fab.querySelector('.map-app__end-badge');
    if (idle > 0) {
      if (!badge) { badge = h('span', { class: 'map-app__end-badge num' }); V.fab.appendChild(badge); }
      badge.textContent = String(idle);
      badge.setAttribute('aria-label', fmt(tx(app, 'map.idleSquads', '指示待ち {n}'), { n: idle }));
      V.fab.title = fmt(tx(app, 'map.idleSquads', '指示待ち {n}'), { n: idle });
    } else {
      if (badge) badge.remove();
      V.fab.removeAttribute('title');
    }
  }
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

// ---------- 初回だけの案内（ナビゲーターが「部隊をタップ → 行き先をタップ」を一度だけ） ----------

function guideWanted(app) {
  return !app.ui.executing && getSetting(GUIDE_KEY, false) !== true;
}

function updateGuide(app) {
  if (!V) return;
  if (!V.guide) {
    if (!guideWanted(app) || V.guideClosed) return;
    V.guide = { step: null, el: null, typing: null, timer: 0, tile: null };
    V.guideShown = true;
  }
  if (app.ui.executing) { endGuide(false); return; }
  if (V.guide.step === 'done') return;
  guideStep(app, selectedSquad(app) ? 'dest' : 'squad');
}

function guideStep(app, step) {
  const g = V && V.guide;
  if (!g || g.step === step) return;
  g.step = step;
  const st = app.state;
  if (step === 'squad') {
    const first = idleSquads(st)[0] || mySquads(st)[0];
    g.tile = first ? first.tile : null;
  } else g.tile = null;
  const text = step === 'squad' ? tx(app, 'map.guideSquad', 'まずは自分の部隊をタップしてね。光っているところにいるよ')
    : step === 'dest' ? tx(app, 'map.guideDest', '次は行き先のタイルをタップ。線が伸びたら「この経路で行く」で決まり')
      : tx(app, 'map.guideDone', 'その調子。全員に指示を出したら「ターン終了」で 1 日が進むよ');
  if (!g.el) {
    const pic = h('img', { class: 'map-guide__navi hero-img', src: img(NAVI.point), alt: '', width: 96, height: 128 });
    pic.addEventListener('error', () => pic.remove(), { once: true });
    const bubble = h('p', { class: 'map-guide__text' });
    const ok = h('button', { class: 'btn-ghost map-guide__ok', type: 'button', onClick: () => endGuide(true) }, tx(app, 'map.guideOk', 'わかった'));
    g.el = h('aside', { class: 'map-guide', 'aria-live': 'polite' },
      pic,
      h('div', { class: 'map-guide__bubble panel panel--raised' },
        h('span', { class: 'map-guide__name' }, tx(app, 'chat.mine', 'マインちゃん')), bubble, ok));
    g.pic = pic;
    g.bubble = bubble;
    V.stage.appendChild(g.el);
  } else if (motion() && g.el.animate) {
    g.el.querySelector('.map-guide__bubble').animate([{ transform: 'scale(.94)' }, { transform: 'scale(1.03)' }, { transform: 'none' }], { duration: fx.token('--t-ui', 240) * 1.4, easing: 'ease-out' });
  }
  // 話している間は口を動かす
  if (g.typing) g.typing.cancel();
  clearInterval(g.timer);
  let f = 0;
  if (motion() && g.pic) {
    g.timer = setInterval(() => { f += 1; if (g.pic) g.pic.src = img(NAVI.talk[f % 2]); }, 140);
  }
  const rest = step === 'done' ? NAVI.smile : NAVI.point;
  g.typing = fx.typeText(g.bubble, text, { cps: 34, skipOn: g.el });
  g.typing.done.then(() => {
    clearInterval(g.timer);
    if (g.pic && V && V.guide === g) g.pic.src = img(rest);
  });
  if (step === 'done') {
    setSetting(GUIDE_KEY, true);
    clearTimeout(g.closeTimer);
    g.closeTimer = setTimeout(() => { if (V && V.guide === g) endGuide(true); }, 4200);
  }
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
  const tools = h('div', { class: 'map-app__tools' });
  const fab = h('button', { class: 'btn-primary map-app__end', type: 'button', onClick: () => endTurn() }, h('span', { class: 'map-app__end-label' }, t(app, 'map.endTurn')));
  const vignette = h('div', { class: 'map-app__vignette', 'aria-hidden': 'true' });
  const stage = h('div', { class: 'map-app__stage' }, canvas, vignette, chip, tools, fab);
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
    tools: el.querySelector('.map-app__tools'),
    fab: el.querySelector('.map-app__end'),
    cw: 0, ch: 0, dpr: 0, raf: 0, dirty: true, lastDraw: 0, sc: null, sctx: null, staticKey: '', staticDirty: true,
    pointers: new Map(), drag: null, pinch: null,
    anims: new Map(), lunges: new Map(), floats: [], taps: [], shake: null, camAnim: null, reach: null,
    selFx: null, pathFx: null, chipFor: null, legend: null, legendOpen: false,
    guide: null, guideShown: false, guideClosed: false, lastHit: null, cutins: Promise.resolve(),
    claims: [], offs: [], ro: null,
  };
  const ui = mv(app);
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
  for (const off of V.offs) { try { off(); } catch { /* 無視 */ } }
  if (V.ro) V.ro.disconnect();
  V = null;
}

/** 陥落のカットイン（続けて落ちたら順に）。攻めたヒーローの絵が文字の手前に重なる */
function fallCutin(opts) {
  if (!V) return;
  V.cutins = V.cutins.then(() => fx.cutin(opts)).catch(() => {});
}

/** 実行フェーズの 1 歩（SPEC-111 §8、SPEC-112 §3） */
export function onEvent(app, ev) {
  if (!V || !ev) return;
  const st = app.state;
  const tm = now();
  const mo = motion();
  const step = (mo ? STEP_MS : 120) || 350;
  const z = app.ui.mapCam.zoom;
  switch (ev.t) {
    case 'move': {
      if (mo) V.anims.set(ev.squad, { from: ev.from, to: ev.to, t0: tm, dur: step * 0.85 });
      const sq = st.squads[ev.squad];
      if (sq && sq.land === st.playerLand) {
        // 自分の部隊の動きにカメラが付いていく
        const to = tileWorld(st, ev.to);
        const cam = app.ui.mapCam;
        const P = period(st);
        let dx = to.x - cam.x;
        dx = ((dx % P) + P * 1.5) % P - P / 2;
        if (mo) V.camAnim = { fx: cam.x, fy: cam.y, fz: cam.zoom, tx: cam.x + dx, ty: to.y, tz: cam.zoom, t0: tm, dur: step * 0.9 };
        else { cam.x += dx; cam.y = to.y; clampCam(app); }
      }
      break;
    }
    case 'battle': {
      const at = tileWorld(st, ev.at);
      const attacker = st.squads[ev.attacker];
      const mineAtk = attacker && attacker.land === st.playerLand;
      const hitDelay = mo ? 130 : 0;
      const add = (wx, wy, text, color, scale = 0.62, dy = 0, delay = 0, shine = false) => V.floats.push({ wx, wy, text, color, scale, dy, t0: tm + delay, dur: 1150 + delay, shine });
      // 攻撃側が少し前に出てから戻る
      if (attacker && mo && attacker.tile !== ev.at) {
        const a = tileWorld(st, attacker.tile);
        const P = period(st);
        let dx = at.x - a.x;
        dx = ((dx % P) + P * 1.5) % P - P / 2;
        const len = Math.hypot(dx, at.y - a.y) || 1;
        V.lunges.set(attacker.id, { ux: dx / len, uy: (at.y - a.y) / len, t0: tm, dur: 360 });
      }
      if (ev.ambush) add(at.x, at.y, t(app, 'execute.ambush'), '#ffd34d', 0.5, -BASE * z * 0.7);
      add(at.x, at.y, ev.evaded ? t(app, 'execute.evaded') : `-${ev.dmg}`, ev.evaded ? '#6fd8e8' : '#ff6464', ev.evaded ? 0.55 : 0.75, 0, hitDelay, !ev.evaded);
      if (ev.skill && ev.skill.name) add(at.x, at.y, ev.skill.name, '#fff1c8', 0.36, BASE * z * 0.9, hitDelay);
      // MCH のバトルエフェクトを 1 回。スキルは別の絵
      if (!ev.evaded) {
        const pt = tileClient(app, ev.at);
        const size = Math.max(120, Math.round(BASE * z * 3.4));
        if (pt) setTimeout(() => { if (V) fx.spriteOnce(ev.skill && ev.skill.name ? '02_area_damage' : '01_single_damage', pt, { size }); }, hitDelay);
        if (mo) V.shake = { t0: tm + hitDelay, dur: 220, amp: ev.result ? 5 : 2.5 };
      }
      if (ev.counter && attacker) {
        const ap = tileWorld(st, attacker.tile);
        add(ap.x, ap.y, ev.counter.evaded ? t(app, 'execute.evaded') : `-${ev.counter.dmg}`, ev.counter.evaded ? '#6fd8e8' : '#ff6464', 0.55, 0, hitDelay + 220, !ev.counter.evaded);
        const pt = !ev.counter.evaded ? tileClient(app, attacker.tile) : null;
        if (pt) setTimeout(() => { if (V) fx.spriteOnce('01_single_damage', pt, { size: Math.max(96, Math.round(BASE * z * 2.6)) }); }, hitDelay + 220);
      }
      // 自分の部隊が戦っていて画面の外なら寄る
      if (mineAtk && !tileClient(app, ev.at)) flyTo(app, ev.at, { dur: step * 0.9 });
      V.lastHit = { attacker: ev.attacker, land: attacker ? attacker.land : null, at: ev.at, result: ev.result || null };
      break;
    }
    default:
      if (BAND_EVENTS.has(ev.t)) {
        // 通知の文があればそれを使う（自分が落とした砦は通知が battle 側に付くので、ここで文を組む）
        const n = noticesFrom(st, app.db, [ev]);
        let fallback = ev.t === 'clear' ? t(app, 'end.clear') : ev.t === 'home_fallen' ? t(app, 'end.home_fallen') : t(app, 'map.fort');
        let title = null;
        if (ev.t === 'fort_fallen') {
          const f = st.forts[ev.fort];
          const fname = f ? (f.name || t(app, `fort.${f.rank}`)) : t(app, 'map.fort');
          fallback = ev.by === st.playerLand ? `${fname}を落としました` : `${landName(app, ev.by)}が${fname}を落としました`;
          title = tx(app, 'map.fortFallen', '砦 陥落');
        } else if (ev.t === 'home_fallen') {
          title = tx(app, 'map.homeFallen', '本拠地 陥落');
        }
        const text = n[0] ? n[0].text : fallback;
        if (title) {
          // 攻めたヒーロー（直前の戦闘の攻撃側。無ければ攻めたランドの部隊）
          const hit = V.lastHit;
          let sq = hit && hit.land === ev.by ? st.squads[hit.attacker] : null;
          if (!sq) sq = Object.values(st.squads || {}).find((s) => s.land === ev.by) || null;
          const hero = heroOf(app.db, sq);
          const side = ev.by === st.playerLand ? 'ally' : 'opponent';
          if (mo) V.shake = { t0: tm, dur: 420, amp: 7 };
          const at = ev.t === 'fort_fallen' && st.forts[ev.fort] ? st.forts[ev.fort].tile : (st.lands[ev.land] && st.lands[ev.land].home);
          if (at != null) {
            const pt = tileClient(app, at);
            if (pt) fx.spriteOnce('04_buff', pt, { size: Math.max(140, Math.round(BASE * z * 4)) });
          }
          if (hero) fallCutin({ image: hero.image, title, sub: text, side, se: null });
          else band(text, { kind: side === 'ally' ? 'good' : 'bad' });
        } else {
          band(text, { kind: 'good' });
        }
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
          if (pt) fx.spriteOnce('03_heal_resurrection', pt, { size: Math.max(100, Math.round(BASE * z * 2.6)) });
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
