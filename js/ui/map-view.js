// map-view.js — MCH Map（ヘックスマップ。SPEC-111 §3・§8。スタイルは css/map.css）
//
// canvas に描く。描く順（下から）: 地形 → 占領色 → 霧 → 施設 → 砦 → 本拠地 → 部隊 → 到達範囲・経路・選択。
// 東西ループ: カメラの見えている範囲の列を、折り返さない列番号で並べて描く（左右に最大 2 周ぶん）。
// 操作: ドラッグでパン、ホイール / ピンチでズーム、タップ（6px 未満の動き）でタイルを選ぶ。
//
// ゲームのルールはここに書かない。経路・到達範囲・指示の可否・射程・攻撃対象はエンジンに聞く
// （pathfind.findPath / reachable、orders.validate / queue / apMax、turn.targetAt、heroes.rangeOf）。
//
// ビューの約束（js/main.js の先頭）: render / mount / unmount / onEvent / onExecuteEnd。

import { h, clear, on, toast, band, reducedMotion, landAssetPath } from './h.js';
import { img } from '../constants.js';
import { uiText, say } from '../engine/lines.js';
import { toPixel, fromPixel, wrapC } from '../engine/hex.js';
import { findPath, reachable, stepCost } from '../engine/pathfind.js';
import { queue, validate, apMax, projectedTile } from '../engine/orders.js';
import { rangeOf } from '../engine/heroes.js';
import { targetAt, noticesFrom } from '../engine/turn.js';
import { terrainYield } from '../engine/economy.js';
import { save } from '../state.js';
import { endTurn, STEP_MS } from '../main.js';

/** zoom 1 の 1 ヘックスの大きさ（main.js の HEX_SIZE と同じ。mapCam はこの基準のワールド座標） */
const BASE = 28;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.5;
/** これ以上動いたらタップではなくドラッグ */
const TAP_SLOP = 6;
const SQRT3 = Math.sqrt(3);
const ENEMY = 'enemy';

const FORT_COLOR = { rare: '#5ab4c4', epic: '#bb86fc', legendary: '#c4a35a' };
const ENEMY_COLOR = '#e76060';
const ACCENT = '#c4a35a';

// pointy-top の頂点（単位ヘックス）
const HX = [];
const HY = [];
for (let i = 0; i < 6; i++) {
  const a = (Math.PI / 180) * (60 * i - 30);
  HX.push(Math.cos(a));
  HY.push(Math.sin(a));
}

const BAND_EVENTS = new Set(['fort_fallen', 'home_fallen', 'clear']);

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

/** Map だけの画面の状態（app.ui.mapView） */
function mv(app) {
  if (!app.ui.mapView) {
    let debug = false;
    try { debug = new URLSearchParams(location.search).get('debug') === '1'; } catch { debug = false; }
    app.ui.mapView = { plan: null, debug, show: { yield: false, owner: false, fog: false }, menu: false, focusedSquad: null };
  }
  return app.ui.mapView;
}

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

/** タイルが画面の端に隠れていれば寄せる */
function ensureVisible(app, tile) {
  if (!V || tile == null) return;
  const p = tileWorld(app.state, tile);
  const s = toScreen(app, p.x, p.y);
  const m = BASE * app.ui.mapCam.zoom;
  if (s.x < m || s.x > V.cw - m || s.y < m || s.y > V.ch - m) {
    centerOn(app, tile);
    requestDraw();
  }
}

// ------------------------------------------------------------
// 描画
// ------------------------------------------------------------

function requestDraw() {
  if (!V || V.raf) return;
  V.raf = requestAnimationFrame(frame);
}

function now() {
  return (typeof performance !== 'undefined' ? performance.now() : 0);
}

function frame() {
  if (!V) return;
  V.raf = 0;
  const tm = now();
  // カメラの追従
  if (V.camAnim) {
    const a = V.camAnim;
    const k = Math.min(1, (tm - a.t0) / a.dur);
    const e = 1 - (1 - k) * (1 - k);
    V.app.ui.mapCam.x = a.fx + (a.tx - a.fx) * e;
    V.app.ui.mapCam.y = a.fy + (a.ty - a.fy) * e;
    if (k >= 1) V.camAnim = null;
    clampCam(V.app);
  }
  for (const [id, a] of V.anims) if (tm - a.t0 >= a.dur) V.anims.delete(id);
  V.floats = V.floats.filter((f) => tm - f.t0 < f.dur);
  draw(V.app, tm);
  if (V.anims.size || V.floats.length || V.camAnim) requestDraw();
}

function hexPath(ctx, x, y, s) {
  ctx.beginPath();
  ctx.moveTo(x + HX[0] * s, y + HY[0] * s);
  for (let i = 1; i < 6; i++) ctx.lineTo(x + HX[i] * s, y + HY[i] * s);
  ctx.closePath();
}

function alpha(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return `rgba(140,127,176,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
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
  ctx.fillStyle = 'rgba(18,16,24,.85)';
  ctx.fillRect(x - 1, y - 1, w + 2, hh + 2);
  ctx.fillStyle = color;
  ctx.fillRect(x, y, Math.max(0, Math.min(1, ratio)) * w, hh);
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
        x: V.cw / 2 + (p.x - cam.x) * z,
        y: V.ch / 2 + (p.y - cam.y) * z,
      });
    }
  }
  return out;
}

function draw(app, tm = now()) {
  if (!V || !V.ctx || !app.state) return;
  const { ctx, cw, ch, dpr } = V;
  const st = app.state;
  const db = app.db;
  const ui = mv(app);
  const s = BASE * app.ui.mapCam.zoom;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#121018';
  ctx.fillRect(0, 0, cw, ch);

  const cells = visibleCells(app);
  const tiles = st.map.tiles;
  const exp = exploredSet(st);
  const fogOff = ui.show.fog;
  const seen = (i) => fogOff || exp.has(i);

  // 1. 地形
  for (const c of cells) {
    const terr = db.terrain[tiles[c.tile].terrain];
    hexPath(ctx, c.x, c.y, s + 0.6);
    ctx.fillStyle = terr ? terr.color : '#2a2438';
    ctx.fill();
  }
  // 2. 占領色（35%）
  for (const c of cells) {
    const tl = tiles[c.tile];
    if (!tl.owner || !seen(c.tile)) continue;
    hexPath(ctx, c.x, c.y, s);
    ctx.fillStyle = alpha(landColor(db, tl.owner), ui.show.owner ? 0.7 : 0.35);
    ctx.fill();
    if (s >= 14 && tl.owner !== ENEMY) {
      hexPath(ctx, c.x, c.y, s - 1.5);
      ctx.strokeStyle = alpha(landColor(db, tl.owner), 0.8);
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
  // 細い境界線
  if (s >= 16) {
    ctx.strokeStyle = 'rgba(0,0,0,.16)';
    ctx.lineWidth = 1;
    for (const c of cells) { hexPath(ctx, c.x, c.y, s); ctx.stroke(); }
  }
  // 3. 霧（未探索は黒 80%）
  if (!fogOff) {
    ctx.fillStyle = 'rgba(0,0,0,.8)';
    for (const c of cells) {
      if (exp.has(c.tile)) continue;
      hexPath(ctx, c.x, c.y, s + 0.6);
      ctx.fill();
    }
  }
  // 産出（デバッグ表示）
  if (ui.show.yield && s >= 14) {
    ctx.font = `700 ${Math.max(8, s * 0.32)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const c of cells) {
      const y = terrainYield(db, tiles[c.tile].terrain);
      ctx.fillStyle = '#121018';
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
      ctx.fillStyle = build && !tl.facility ? 'rgba(42,36,56,.75)' : 'rgba(18,16,24,.85)';
      ctx.fill();
      ctx.strokeStyle = landColor(db, tl.owner || (build && build.land));
      ctx.lineWidth = 1;
      if (build) ctx.setLineDash([2, 2]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#e6e0f0';
      const rank = tl.facility ? tl.facility.rank : 0;
      ctx.fillText(rank ? `${mark}${rank}` : mark, bx + bw / 2, by + bh / 2 + 0.5);
    }
  }
  // 5. 砦（ランクの色の枠 + エネミーの絵 + 耐久）
  for (const c of cells) {
    const tl = tiles[c.tile];
    if (!tl.fort || !seen(c.tile)) continue;
    const fort = st.forts[tl.fort];
    if (!fort) continue;
    const col = FORT_COLOR[fort.rank] || ACCENT;
    hexPath(ctx, c.x, c.y, s - 2);
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
      ctx.strokeStyle = '#121018';
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
    hexPath(ctx, c.x, c.y, s - 1.5);
    ctx.lineWidth = Math.max(2, s * 0.14);
    ctx.strokeStyle = home.land.alive === false ? '#5a5248' : col;
    ctx.stroke();
    const im = def ? getImage(landAssetPath(def.icon)) : null;
    const size = s * 1.35;
    ctx.globalAlpha = home.land.alive === false ? 0.4 : 1;
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
  // 7. 部隊（ヒーローの絵。敵は赤い縁）
  const byTile = new Map();
  for (const sq of Object.values(st.squads || {})) {
    if (V.anims.has(sq.id)) continue;
    if (!byTile.has(sq.tile)) byTile.set(sq.tile, []);
    byTile.get(sq.tile).push(sq);
  }
  for (const c of cells) {
    const list = byTile.get(c.tile);
    if (!list || !seen(c.tile)) continue;
    list.sort((a, b) => (a.land === st.playerLand) - (b.land === st.playerLand));
    const n = Math.min(list.length, 3);
    // 砦・本拠地のタイルでは、絵を隠さないように下へ寄せて小さく
    const busy = !!tiles[c.tile].fort || !!homeAt(st, c.tile);
    const ss = busy ? s * 0.7 : s;
    const yy = busy ? c.y + s * 0.42 : c.y - s * 0.05;
    for (let k = 0; k < n; k++) {
      const off = (k - (n - 1) / 2) * ss * 0.42;
      drawSquad(app, list[list.length - n + k], c.x + off, yy, ss);
    }
    if (list.length > 1 && s >= 12) {
      const fs = Math.max(9, s * 0.34);
      ctx.font = `800 ${fs}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#121018';
      ctx.beginPath();
      ctx.arc(c.x + s * 0.62, c.y + s * 0.5, fs * 0.72, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#e6e0f0';
      ctx.fillText(String(list.length), c.x + s * 0.62, c.y + s * 0.52);
    }
  }
  // 動いている部隊（タイル間を滑る）
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
    drawSquad(app, sq, p.x, p.y - s * 0.05, s);
  }

  // 8. 選択・到達範囲・経路
  const sel = !app.ui.executing ? selectedSquad(app) : null;
  if (sel) {
    // 到達範囲: 届かない（見えている）タイルを暗くし、届くタイルを薄く明るくする
    const reach = reachOf(app, sel);
    for (const c of cells) {
      if (!seen(c.tile)) continue;
      const inReach = reach && reach.has(c.tile);
      hexPath(ctx, c.x, c.y, inReach ? s - 1 : s + 0.6);
      ctx.fillStyle = inReach ? 'rgba(255,248,225,.16)' : 'rgba(0,0,0,.32)';
      ctx.fill();
    }
    const here = projectedTile(sel);
    for (const c of cells) {
      if (c.tile !== sel.tile && c.tile !== here) continue;
      hexPath(ctx, c.x, c.y, s - 1);
      ctx.lineWidth = 3;
      ctx.strokeStyle = ACCENT;
      ctx.stroke();
    }
    drawQueued(app, sel, s);
    if (ui.plan && ui.plan.squad === sel.id && ui.plan.path) drawPath(app, sel, ui.plan, s);
  }
  if (app.ui.tile != null) {
    for (const c of cells) {
      if (c.tile !== app.ui.tile) continue;
      hexPath(ctx, c.x, c.y, s - 1);
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#e6e0f0';
      ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  // 浮く文字（ダメージ・奇襲・回避）
  for (const f of V.floats) {
    const k = Math.min(1, (tm - f.t0) / f.dur);
    const p = toScreen(app, f.wx, f.wy);
    const rise = reducedMotion() ? 0 : k * s * 1.2;
    ctx.globalAlpha = k > 0.7 ? (1 - k) / 0.3 : 1;
    ctx.font = `900 ${Math.max(13, s * f.scale)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#121018';
    ctx.strokeText(f.text, p.x, p.y - s * 0.6 - rise + f.dy);
    ctx.fillStyle = f.color;
    ctx.fillText(f.text, p.x, p.y - s * 0.6 - rise + f.dy);
    ctx.globalAlpha = 1;
  }
}

function drawSquad(app, sq, x, y, s) {
  const ctx = V.ctx;
  const st = app.state;
  const mine = sq.land === st.playerLand;
  const size = Math.max(14, s * 1.15);
  const half = size / 2;
  ctx.globalAlpha = sq.status === 'routed' ? 0.5 : 1;
  roundRect(ctx, x - half, y - half, size, size, Math.max(3, size * 0.18));
  ctx.fillStyle = 'rgba(18,16,24,.72)';
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
  roundRect(ctx, x - half, y - half, size, size, Math.max(3, size * 0.18));
  ctx.lineWidth = mine ? 2 : 2.5;
  ctx.strokeStyle = mine ? landColor(app.db, sq.land) : ENEMY_COLOR;
  ctx.stroke();
  if (app.ui.selectedSquad === sq.id && !app.ui.executing) {
    ctx.lineWidth = 2;
    ctx.strokeStyle = ACCENT;
    roundRect(ctx, x - half - 3, y - half - 3, size + 6, size + 6, Math.max(4, size * 0.22));
    ctx.stroke();
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

function drawPath(app, sq, plan, s) {
  const ctx = V.ctx;
  const pts = pathPoints(app, plan.from, plan.path);
  // 今日の AP で届くところまでは金、それより先は薄い色
  const hero = heroOf(app.db, sq);
  let acc = 0;
  let split = plan.path.length;
  for (let i = 0; i < plan.path.length; i++) {
    acc += stepCost(app.state, app.db, sq, hero, plan.path[i]);
    if (acc > (sq.ap || 0)) { split = i; break; }
  }
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const seg = (from, to, color, dash) => {
    if (to <= from) return;
    ctx.beginPath();
    ctx.moveTo(pts[from].x, pts[from].y);
    for (let i = from + 1; i <= to; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.lineWidth = Math.max(5, s * 0.26);
    ctx.strokeStyle = 'rgba(18,16,24,.75)';
    ctx.setLineDash([]);
    ctx.stroke();
    ctx.lineWidth = Math.max(3, s * 0.14);
    ctx.strokeStyle = color;
    ctx.setLineDash(dash);
    ctx.stroke();
    ctx.setLineDash([]);
  };
  seg(0, split, ACCENT, []);
  seg(split, pts.length - 1, '#a197c2', [6, 5]);
  const end = pts[pts.length - 1];
  ctx.beginPath();
  ctx.arc(end.x, end.y, Math.max(5, s * 0.24), 0, Math.PI * 2);
  ctx.fillStyle = ACCENT;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#121018';
  ctx.stroke();
}

/** 積んである移動（薄く） */
function drawQueued(app, sq, s) {
  const ctx = V.ctx;
  let from = sq.tile;
  for (const o of sq.orders || []) {
    if (o.type !== 'move' || !Array.isArray(o.path) || !o.path.length) continue;
    const pts = pathPoints(app, from, o.path);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.lineWidth = Math.max(2, s * 0.1);
    ctx.strokeStyle = 'rgba(230,224,240,.75)';
    ctx.setLineDash([3, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
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
    return { kind: 'attack', squad: sq.id, tile, from, ok: v.ok, reason: v.reason, siege, name: targetName(app, target), range: rangeOf(hero) };
  }
  const at = from === sq.tile ? sq : { ...sq, tile: from };
  const p = findPath(st, db, at, hero, tile);
  if (!p || !p.path.length) return { kind: 'move', squad: sq.id, tile, from, path: null, ok: false, reason: 'terrain' };
  const max = apMax(hero, sq, db);
  const days = max > 0 ? Math.max(1, Math.ceil(p.cost / max)) : null;
  const v = validate(st, db, sq, { type: 'move', path: p.path });
  return { kind: 'move', squad: sq.id, tile, from, path: p.path, cost: p.cost, days, ok: v.ok, reason: v.reason };
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
    toast(rejectText(app, sq, r.reason), { key: 'map-reject' });
    ui.plan = makePlan(app, sq, plan.tile);
    renderSheet(app);
    return;
  }
  const text = plan.kind === 'attack'
    ? say(app.db, hero, 'order.attack.ack', { target: plan.name })
    : say(app.db, hero, 'order.move.ack', { dest: tileTitle(app, plan.tile), days: plan.days ?? '-' });
  toast(text, { key: 'map-ack' });
  try { save(st); } catch (e) { console.error(e); }
  ui.plan = null;
  if (V) V.reach = null;
  renderSheet(app);
  renderOverlay(app);
  requestDraw();
}

function selectSquad(app, id) {
  app.ui.selectedSquad = id;
  const ui = mv(app);
  ui.plan = null;
  ui.focusedSquad = id;
  if (V) V.reach = null;
  renderSheet(app);
  renderOverlay(app);
  requestDraw();
}

function openTile(app, tile) {
  const ui = mv(app);
  app.ui.tile = tile;
  const sq = !app.ui.executing ? selectedSquad(app) : null;
  ui.plan = sq && tile !== projectedTile(sq) ? makePlan(app, sq, tile) : null;
  renderSheet(app);
  requestDraw();
  requestAnimationFrame(() => ensureVisible(app, tile));
}

function closeSheet(app) {
  app.ui.tile = null;
  mv(app).plan = null;
  renderSheet(app);
  requestDraw();
}

// ------------------------------------------------------------
// DOM（情報シート・上の札・ターン終了）
// ------------------------------------------------------------

function row(label, ...value) {
  return h('div', { class: 'map-sheet__row' }, h('dt', null, label), h('dd', null, ...value));
}

function squadItem(app, sq) {
  const st = app.state;
  const db = app.db;
  const hero = heroOf(db, sq);
  const mine = sq.land === st.playerLand;
  const max = mine && hero ? apMax(hero, sq, db) : null;
  const imgNode = hero ? h('img', { class: 'map-squad__img hero-img', src: img(hero.image), alt: hero.name, width: 40, height: 40, loading: 'lazy' }) : null;
  if (imgNode) imgNode.addEventListener('error', () => { imgNode.replaceWith(h('span', { class: 'map-squad__img img-fallback', role: 'img', 'aria-label': hero.name }, hero.name.slice(0, 1))); }, { once: true });
  const body = [
    imgNode,
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
      class: ['map-squad__btn', selected ? 'is-selected' : null], type: 'button', 'aria-pressed': selected ? 'true' : 'false',
      onClick: () => selectSquad(app, selected ? null : sq.id),
    }, body, h('span', { class: 'map-squad__pick' }, selected ? t(app, 'map.selected') : '')));
}

function planBlock(app, plan) {
  const st = app.state;
  const sq = st.squads[plan.squad];
  if (!sq) return null;
  if (plan.kind === 'attack') {
    const label = t(app, plan.siege ? 'map.siege' : 'map.attack');
    const note = plan.ok ? null
      : plan.reason === 'range' ? fmt(t(app, 'map.outOfRange'), { n: plan.range })
        : rejectText(app, sq, plan.reason);
    return h('div', { class: 'map-plan' },
      h('p', { class: 'map-plan__target' }, plan.name),
      note ? h('p', { class: 'map-plan__note' }, note) : null,
      h('button', { class: 'btn-primary map-plan__go', type: 'button', disabled: !plan.ok, onClick: () => applyPlan(app) }, label));
  }
  if (!plan.path) return h('div', { class: 'map-plan' }, h('p', { class: 'map-plan__note' }, t(app, 'map.unreachable')));
  return h('div', { class: 'map-plan' },
    h('dl', { class: 'map-plan__facts' },
      h('div', null, h('dt', null, t(app, 'map.days')), h('dd', { class: 'num' }, plan.days != null ? fmt(t(app, 'map.daysUnit'), { n: plan.days }) : '-')),
      h('div', null, h('dt', null, t(app, 'map.cost')), h('dd', { class: 'num' }, String(plan.cost))),
      h('div', null, h('dt', null, t(app, 'map.apLeft')), h('dd', { class: 'num' }, String(sq.ap || 0)))),
    plan.ok ? null : h('p', { class: 'map-plan__note' }, rejectText(app, sq, plan.reason)),
    h('button', { class: 'btn-primary map-plan__go', type: 'button', disabled: !plan.ok, onClick: () => applyPlan(app) }, t(app, 'map.go')));
}

function renderSheet(app) {
  if (!V || !V.sheet) return;
  const el = V.sheet;
  clear(el);
  const tile = app.ui.tile;
  const st = app.state;
  if (tile == null || !st.map.tiles[tile]) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const db = app.db;
  const tl = st.map.tiles[tile];
  const visible = isVisible(app, tile);
  const terr = db.terrain[tl.terrain];
  const plan = mv(app).plan;

  el.appendChild(h('header', { class: 'map-sheet__head' },
    h('h2', { class: 'map-sheet__title', id: 'map-sheet-title' }, tileTitle(app, tile)),
    h('button', { class: 'btn-ghost map-sheet__x', type: 'button', 'aria-label': t(app, 'common.close'), onClick: () => closeSheet(app) }, '×')));

  if (plan) el.appendChild(planBlock(app, plan));

  if (!visible) {
    el.appendChild(h('p', { class: 'muted map-sheet__fog' }, t(app, 'map.unexplored')));
    return;
  }
  const y = terrainYield(db, tl.terrain);
  const rows = [
    row(t(app, 'map.terrain'), terr ? terr.name : tl.terrain),
    row(t(app, 'map.yield'), h('span', { class: 'num' }, `${t(app, 'res.food')} ${y.food}  ${t(app, 'res.gum')} ${y.gum}  ${t(app, 'res.mat')} ${y.mat}`)),
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
    rows.push(row(t(app, 'map.fort'),
      h('span', { class: 'map-sheet__fort', style: { '--rank': FORT_COLOR[f.rank] || ACCENT } }, t(app, `fort.${f.rank}`)),
      en ? ` ${en.name}` : ''));
    rows.push(row(t(app, 'fort.troops'), h('span', { class: 'num' }, String(f.troops))));
    rows.push(row(t(app, 'fort.durability'), h('span', { class: 'num' }, `${f.durability} / ${f.maxDurability}`)));
  }
  const home = homeAt(st, tile);
  if (home) {
    const dur = typeof home.land.homeDurability === 'number' ? home.land.homeDurability : 100;
    rows.push(row(t(app, 'map.home'), landName(app, home.id)));
    rows.push(row(t(app, 'map.homeDurability'), h('span', { class: 'num' }, `${dur} / 100`)));
  }
  el.appendChild(h('dl', { class: 'map-sheet__facts' }, rows));

  const list = squadsAt(st, tile);
  el.appendChild(h('h3', { class: 'section-title' }, t(app, 'map.squads')));
  el.appendChild(list.length
    ? h('ul', { class: 'map-squads' }, list.map((sq) => squadItem(app, sq)))
    : h('p', { class: 'muted map-sheet__empty' }, t(app, 'map.noSquads')));
}

function renderOverlay(app) {
  if (!V) return;
  const ui = mv(app);
  clear(V.chip);
  const sq = !app.ui.executing ? selectedSquad(app) : null;
  if (sq) {
    const hero = heroOf(app.db, sq);
    const n = (sq.orders || []).length;
    const imgNode = hero ? h('img', { class: 'map-chip__img hero-img', src: img(hero.image), alt: hero.name, width: 32, height: 32 }) : null;
    if (imgNode) imgNode.addEventListener('error', () => imgNode.replaceWith(h('span', { class: 'map-chip__img img-fallback', role: 'img', 'aria-label': hero.name }, hero.name.slice(0, 1))), { once: true });
    V.chip.appendChild(h('div', { class: 'map-chip' },
      imgNode,
      h('span', { class: 'map-chip__text' },
        h('span', { class: 'map-chip__name' }, hero ? hero.name : sq.id),
        h('span', { class: 'map-chip__sub num' }, `${t(app, 'map.apLeft')} ${sq.ap || 0}`, n ? `  ${t(app, 'map.orders')} ${n}` : '', `  ${t(app, 'map.pickHint')}`)),
      h('button', { class: 'btn-ghost map-chip__x', type: 'button', 'aria-label': t(app, 'map.deselect'), onClick: () => selectSquad(app, null) }, '×')));
  } else if (!app.ui.executing) {
    V.chip.appendChild(h('p', { class: 'map-hint' }, t(app, 'map.selectHint')));
  }

  clear(V.tools);
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
  V.fab.hidden = !!app.ui.executing;
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
  const p = localPoint(e);
  const k = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
  zoomAround(V.app, p.x, p.y, V.app.ui.mapCam.zoom * k);
}

function onKey(e) {
  if (!V) return;
  const app = V.app;
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
    clampCam(app);
    requestDraw();
  }
}

function onTap(app, tile) {
  const sq = !app.ui.executing ? selectedSquad(app) : null;
  // 自分の部隊が 1 体だけいるタイルを、部隊を選んでいないときにタップしたら、その部隊を選ぶ
  if (!sq && !app.ui.executing) {
    const mine = squadsAt(app.state, tile).filter((s) => s.land === app.state.playerLand);
    if (mine.length === 1) {
      app.ui.selectedSquad = mine[0].id;
      mv(app).focusedSquad = mine[0].id;
      if (V) V.reach = null;
      renderOverlay(app);
    }
  }
  openTile(app, tile);
}

function resize() {
  if (!V) return;
  const r = V.stage.getBoundingClientRect();
  const dpr = Math.min(3, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
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
  const canvas = h('canvas', { class: 'map-app__canvas', role: 'img', tabindex: '0', 'aria-label': t(app, 'map.mapLabel') });
  const chip = h('div', { class: 'map-app__chip' });
  const tools = h('div', { class: 'map-app__tools' });
  const fab = h('button', { class: 'btn-primary map-app__end', type: 'button', onClick: () => endTurn() }, t(app, 'map.endTurn'));
  const stage = h('div', { class: 'map-app__stage' }, canvas, chip, tools, fab);
  const sheet = h('section', { class: 'map-sheet', 'aria-labelledby': 'map-sheet-title', hidden: true });
  return h('section', { class: 'map-app', dataset: { executing: app.ui.executing ? '1' : '0' } }, stage, sheet);
}

export function mount(app, el) {
  if (V) unmount(app);
  if (!app.state || !el) return;
  const stage = el.querySelector('.map-app__stage');
  const canvas = el.querySelector('.map-app__canvas');
  V = {
    app, el, stage, canvas,
    ctx: canvas.getContext('2d'),
    sheet: el.querySelector('.map-sheet'),
    chip: el.querySelector('.map-app__chip'),
    tools: el.querySelector('.map-app__tools'),
    fab: el.querySelector('.map-app__end'),
    cw: 0, ch: 0, dpr: 0, raf: 0,
    pointers: new Map(), drag: null, pinch: null,
    anims: new Map(), floats: [], camAnim: null, reach: null,
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
    app.ui.mapCam.zoom = Math.min(app.ui.mapCam.zoom, 1.2);
  }
  clampCam(app);

  V.offs.push(on(canvas, 'pointerdown', onPointerDown));
  V.offs.push(on(canvas, 'pointermove', onPointerMove));
  V.offs.push(on(canvas, 'pointerup', onPointerUp));
  V.offs.push(on(canvas, 'pointercancel', onPointerUp));
  V.offs.push(on(canvas, 'wheel', onWheel, { passive: false }));
  V.offs.push(on(canvas, 'contextmenu', (e) => e.preventDefault()));
  V.offs.push(on(document, 'keydown', onKey));
  if (typeof ResizeObserver !== 'undefined') {
    V.ro = new ResizeObserver(() => resize());
    V.ro.observe(stage);
  }
  V.offs.push(on(window, 'resize', resize));

  if (app.ui.tile != null && !app.ui.executing) {
    const s = selectedSquad(app);
    ui.plan = s && app.ui.tile !== projectedTile(s) ? makePlan(app, s, app.ui.tile) : null;
  }
  renderOverlay(app);
  renderSheet(app);
  resize();
  requestDraw();
}

export function unmount() {
  if (!V) return;
  if (V.raf) cancelAnimationFrame(V.raf);
  for (const off of V.offs) off();
  if (V.ro) V.ro.disconnect();
  V = null;
}

/** 実行フェーズの 1 歩（SPEC-111 §8） */
export function onEvent(app, ev) {
  if (!V || !ev) return;
  const st = app.state;
  const tm = now();
  const motion = !reducedMotion();
  const step = (motion ? STEP_MS : 120) || 350;
  switch (ev.t) {
    case 'move': {
      if (motion) V.anims.set(ev.squad, { from: ev.from, to: ev.to, t0: tm, dur: step * 0.85 });
      const sq = st.squads[ev.squad];
      if (sq && sq.land === st.playerLand) {
        const to = tileWorld(st, ev.to);
        const cam = app.ui.mapCam;
        const P = period(st);
        let dx = to.x - cam.x;
        dx = ((dx % P) + P * 1.5) % P - P / 2;
        if (motion) V.camAnim = { fx: cam.x, fy: cam.y, tx: cam.x + dx, ty: to.y, t0: tm, dur: step * 0.85 };
        else { cam.x += dx; cam.y = to.y; clampCam(app); }
      }
      break;
    }
    case 'battle': {
      const at = tileWorld(st, ev.at);
      const add = (wx, wy, text, color, scale = 0.62, dy = 0) => V.floats.push({ wx, wy, text, color, scale, dy, t0: tm, dur: 1100 });
      if (ev.ambush) add(at.x, at.y, t(app, 'execute.ambush'), '#f0c14b', 0.5, -BASE * app.ui.mapCam.zoom * 0.7);
      add(at.x, at.y, ev.evaded ? t(app, 'execute.evaded') : `-${ev.dmg}`, ev.evaded ? '#5ab4c4' : '#e76060');
      if (ev.skill && ev.skill.name) add(at.x, at.y, ev.skill.name, '#e6e0f0', 0.36, BASE * app.ui.mapCam.zoom * 0.9);
      const attacker = st.squads[ev.attacker];
      if (ev.counter && attacker) {
        const ap = tileWorld(st, attacker.tile);
        add(ap.x, ap.y, ev.counter.evaded ? t(app, 'execute.evaded') : `-${ev.counter.dmg}`, ev.counter.evaded ? '#5ab4c4' : '#e76060', 0.5);
      }
      break;
    }
    default:
      if (BAND_EVENTS.has(ev.t)) {
        const n = noticesFrom(st, app.db, [ev]);
        const fallback = ev.t === 'clear' ? t(app, 'end.clear') : ev.t === 'home_fallen' ? t(app, 'end.home_fallen') : t(app, 'map.fort');
        band(n[0] ? n[0].text : fallback);
      } else if (ev.t === 'claim') {
        if (ev.land === st.playerLand) {
          V.claims.push(ev);
          const n = noticesFrom(st, app.db, V.claims);
          if (n[0]) toast(n[0].text, { key: 'ev-claim' });
        }
      } else if (ev.t === 'yield') {
        if (ev.land === st.playerLand && ev.res) {
          const r = ev.res;
          toast(`${t(app, 'map.yieldToast')}  ${t(app, 'res.food')} +${r.food || 0}  ${t(app, 'res.gum')} +${r.gum || 0}  ${t(app, 'res.mat')} +${r.mat || 0}`, { key: 'ev-yield' });
        }
      } else if (ev.t === 'build_start') {
        const sq = st.squads[ev.squad];
        if (sq && sq.land === st.playerLand) {
          const fac = app.db.facilities[ev.kind];
          toast(say(app.db, heroOf(app.db, sq), 'order.build.ack', { kind: fac ? fac.name : ev.kind, days: ev.days }), { key: 'ev-build' });
        }
      } else if (ev.t === 'rest') {
        const sq = st.squads[ev.squad];
        if (sq && sq.land === st.playerLand) toast(`${heroOf(app.db, sq)?.name || ''} ${t(app, 'cmd.rest')} +${ev.amount || 0}`, { key: 'ev-rest' });
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
  V.floats = [];
  V.camAnim = null;
  V.claims = [];
  V.reach = null;
  requestDraw();
}
