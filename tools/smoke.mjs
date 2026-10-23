// smoke.mjs — 通しテスト（ブラウザで実際に押して回る）
//
//   npx --yes -p playwright-core node tools/smoke.mjs [--shots <dir>] [--turns 5]
//   （スクリーンショットはリポジトリに置かない。既定は OS の一時ディレクトリ/mycryptowars-smoke）
//
// - python3 -m http.server を子プロセスで立て、Playwright の Chromium で開く（390x844 と 1280x800）
// - ランド選択 → ホーム → Chat で指示（移動・占領・内政）→ Map で経路を引いて移動 → ターン終了 → スキップ → ホーム
//   を繰り返す。選択待ち（SOUL / エクステンション）が出たら Drive / Photo で処理する
// - Console のエラーと pageerror が 0 であること、各画面が描けることを見る
// - 敵対的な確認: Esc、ポップアップの重なり、render() でトークとスワイプが消えないか、
//   再読み込みで続きから始まるか、28 日目まで進めて結果画面が出るか、絵文字・unit / gold の残り
//
// package.json は置かない。playwright-core は npx で一時的に取る。Chromium は
// PLAYWRIGHT_CHROMIUM か /opt/pw-browsers/chromium-*/chrome-linux/chrome を使う。
// 画像（raw.githubusercontent.com の MCH リポジトリ）は、隣に ../mycryptoheroes があればそこから返す。

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net from 'node:net';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const SHOTS = resolve(argOf('--shots', process.env.SMOKE_SHOTS || join(tmpdir(), 'mycryptowars-smoke')));
const TURNS = Number(argOf('--turns', '5'));
const MCH_REPO = resolve(ROOT, '..', 'mycryptoheroes');

// ------------------------------------------------------------
// 道具
// ------------------------------------------------------------

async function loadPlaywright() {
  try {
    return await import('playwright-core');
  } catch { /* npx の一時ディレクトリを探す */ }
  for (const dir of (process.env.PATH || '').split(':')) {
    if (!dir.endsWith(join('node_modules', '.bin'))) continue;
    const pkg = join(dir, '..', 'playwright-core', 'index.mjs');
    if (existsSync(pkg)) return await import(pathToFileURL(pkg).href);
  }
  throw new Error('playwright-core が見つかりません。 npx --yes -p playwright-core node tools/smoke.mjs で動かしてください');
}

function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM) return process.env.PLAYWRIGHT_CHROMIUM;
  const base = '/opt/pw-browsers';
  if (!existsSync(base)) return undefined;
  const dirs = readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
  for (const d of dirs) {
    const p = join(base, d, 'chrome-linux', 'chrome');
    if (existsSync(p)) return p;
  }
  return undefined;
}

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
    s.on('error', rej);
  });
}

async function startServer() {
  const port = await freePort();
  const child = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return { child, url };
    } catch { /* まだ */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error('http.server が立ち上がりませんでした');
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' };

/** raw.githubusercontent.com/bearko/mycryptoheroes/main/... を手元の clone から返す（無ければ 404） */
async function routeAssets(context) {
  await context.route(/^https:\/\/raw\.githubusercontent\.com\/bearko\/mycryptoheroes\/main\//, (route) => {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/bearko\/mycryptoheroes\/main\//, ''));
    const file = join(MCH_REPO, rel);
    if (file.startsWith(MCH_REPO) && existsSync(file) && statSync(file).isFile()) {
      return route.fulfill({ status: 200, contentType: MIME[extname(file).toLowerCase()] || 'application/octet-stream', body: readFileSync(file) });
    }
    return route.fulfill({ status: 404, body: '' });
  });
}

const EMOJI = /\p{Extended_Pictographic}/u;
const results = { checks: [], errors: [], missingAssets: new Set(), shots: [], pendingSeen: new Set() };
function check(name, ok, detail = '') {
  results.checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// ------------------------------------------------------------
// ページの中で使う小道具
// ------------------------------------------------------------

// ページの中では import('/js/main.js') で、index.html が読んだものと同じモジュールの実体が取れる

async function shot(page, name) {
  const file = join(SHOTS, `smoke-${name}.png`);
  await page.screenshot({ path: file });
  results.shots.push(file);
}

async function screenOk(page, label) {
  const info = await page.evaluate(() => {
    const screen = document.querySelector('.phone__screen');
    const txt = document.body.innerText || '';
    return {
      children: screen ? screen.children.length : 0,
      broken: !!document.querySelector('.phone__screen .app-screen p.muted') && /この画面を描けませんでした/.test(txt),
      popups: document.querySelectorAll('.popup').length,
      emoji: [...txt].filter((c) => /\p{Extended_Pictographic}/u.test(c)).join(''),
      words: (txt.match(/\b(unit|units|gold|Gold|ユニット|ゴールド)\b/g) || []).join(','),
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });
  const ok = info.children > 0 && !info.broken && info.popups <= 1 && !info.emoji && !info.words && !info.overflowX;
  if (!ok) check(`画面が描ける: ${label}`, false, JSON.stringify(info));
  return ok;
}

async function waitFor(page, selector, timeout = 10000) {
  await page.waitForSelector(selector, { timeout, state: 'visible' });
}

async function currentApp(page) {
  return page.evaluate(async () => (await import('/js/main.js')).getApp().ui.app);
}

// ------------------------------------------------------------
// 選択待ち（SOUL / エクステンション）
// ------------------------------------------------------------

async function handlePending(page, tag) {
  for (let guard = 0; guard < 12; guard++) {
    const pa = await page.evaluate(async () => (await import('/js/main.js')).pendingApp());
    if (!pa) return;
    const now = await currentApp(page);
    if (now !== pa) {
      await page.evaluate(async (a) => (await import('/js/main.js')).go(a), pa);
    }
    results.pendingSeen.add(pa);
    if (pa === 'drive') {
      await waitFor(page, '.soul-card');
      await shot(page, `${tag}-drive-soul`);
      await screenOk(page, 'Drive SOUL');
      await page.click('.soul-card');
      await waitFor(page, '.popup .btn-primary');
      await page.click('.popup .btn-primary');
      await page.waitForTimeout(200);
    } else if (pa === 'photo') {
      if (await page.$('.photo-got')) {
        await page.click('.photo-got__actions .btn-secondary');
        continue;
      }
      await waitFor(page, '.swipe-card.is-top');
      await shot(page, `${tag}-photo-swipe`);
      await screenOk(page, 'Photo スワイプ');
      // 1 枚目はドラッグの途中で render() を挟む（はらう途中で描き直しても続く）
      const card = await page.$('.swipe-card.is-top');
      const box = await card.boundingBox();
      const iBefore = await page.evaluate(async () => (await import('/js/main.js')).getApp().ui.swipe.i);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2, { steps: 3 });
      await page.evaluate(async () => (await import('/js/main.js')).render());
      await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, { steps: 4 });
      await page.mouse.up();
      await page.waitForTimeout(450);
      const iAfter = await page.evaluate(async () => { const a = (await import('/js/main.js')).getApp(); return a.ui.swipe ? a.ui.swipe.i : -1; });
      check('スワイプ: ドラッグ中の render() でも 1 枚はらえる', iAfter === -1 || iAfter === iBefore + 1, `i ${iBefore} -> ${iAfter}`);
      // 残りはボタン / 矢印キー
      for (let k = 0; k < 20; k++) {
        if (await page.$('.photo-got') || !(await page.$('.swipe-card.is-top'))) break;
        if (k % 2) await page.keyboard.press('ArrowLeft');
        else await page.click('.swipe__btn--yes');
        await page.waitForTimeout(380);
      }
      await page.waitForSelector('.photo-got, .photo-grid, .photo .empty', { timeout: 12000 });
      await shot(page, `${tag}-photo-got`);
      if (await page.$('.photo-got')) await page.click('.photo-got__actions .btn-secondary');
      await page.waitForTimeout(200);
    } else {
      return;
    }
  }
}

// ------------------------------------------------------------
// 1 ターン
// ------------------------------------------------------------

async function giveOrders(page, tag) {
  await page.click('.app-icon[data-app="chat"]');
  // Chat は最後に開いていたトークを覚えている。一覧へ戻る
  await page.waitForSelector('.chat--list, .chat--talk', { timeout: 10000 });
  if (await page.$('.chat--talk')) await page.click('.chat-head__back');
  await waitFor(page, '.chat--list');
  await shot(page, `${tag}-chat-list`);
  await screenOk(page, 'Chat 一覧');
  const ids = await page.$$eval('.chat-row[data-squad]', (els) => els.map((e) => e.dataset.squad));
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    await page.click(`.chat-row[data-squad="${id}"]`);
    await waitFor(page, '.chat--talk');
    if (i === 0) {
      // 移動は Map で経路を引く
      await page.click('.chat-menu__btn[data-cmd="move"]');
      await waitFor(page, '.map-app__canvas');
      await page.waitForTimeout(150);
      const target = await page.evaluate(async (sid) => {
        const m = await import('/js/main.js');
        const { reachable } = await import('/js/engine/pathfind.js');
        const { projectedTile } = await import('/js/engine/orders.js');
        const { targetAt } = await import('/js/engine/turn.js');
        const { toPixel } = await import('/js/engine/hex.js');
        const app = m.getApp();
        const st = app.state;
        const sq = st.squads[sid];
        const hero = app.db.heroes[sq.heroId] || app.db.heroes[String(sq.heroId)];
        const from = projectedTile(sq);
        if (!sq.ap) return null;
        const map = reachable(st, app.db, { ...sq, tile: from }, hero, sq.ap);
        // 画面上の位置（map-view と同じ式。東西ループはカメラに近い写し）。キャンバスが見えている所だけ選ぶ
        const canvas = document.querySelector('.map-app__canvas');
        const r = canvas.getBoundingClientRect();
        const w = st.map.w;
        const BASE = 28;
        const cam = app.ui.mapCam;
        const P = BASE * Math.sqrt(3) * w;
        const at = (tile) => {
          const p = toPixel(tile % w, Math.floor(tile / w), BASE);
          let dx = p.x - cam.x;
          dx = ((dx % P) + P * 1.5) % P - P / 2;
          return { x: r.left + r.width / 2 + dx * cam.zoom, y: r.top + r.height / 2 + (p.y - cam.y) * cam.zoom };
        };
        let best = null;
        for (const [tile, cost] of map) {
          if (tile === from || targetAt(st, sq.land, tile)) continue;
          const pt = at(tile);
          if (document.elementFromPoint(pt.x, pt.y) !== canvas) continue;
          if (!best || cost > best.cost) best = { tile, cost, ...pt };
        }
        return best;
      }, id);
      if (target) {
        await page.mouse.click(target.x, target.y);
        await page.waitForTimeout(150);
        await shot(page, `${tag}-map-route`);
        await screenOk(page, 'Map 経路');
        const go = await page.$('.map-plan__go:not([disabled])');
        check(`${tag}: Map で経路を引ける`, !!go);
        if (go) {
          const before = await page.evaluate(async (sid) => (await import('/js/main.js')).getApp().state.squads[sid].orders.length, id);
          await go.click();
          const after = await page.evaluate(async (sid) => (await import('/js/main.js')).getApp().state.squads[sid].orders.length, id);
          check(`${tag}: 「この経路で行く」で移動が積まれる`, after === before + 1);
        }
        // Esc でシートを閉じる
        await page.keyboard.press('Escape');
        await page.waitForTimeout(80);
        const sheetHidden = await page.$eval('.map-sheet', (e) => e.hidden || getComputedStyle(e).display === 'none');
        check(`${tag}: Map のシートが Esc で閉じる`, sheetHidden);
      } else {
        check(`${tag}: 移動先が見つかる（AP 0 なら飛ばす）`, true, 'skip');
      }
      await page.click('.app-icon[data-app="chat"]').catch(() => {});
      await page.evaluate(async (sid) => (await import('/js/main.js')).go('chat', { squad: sid }), id);
      await waitFor(page, '.chat--talk');
    }
    // 占領
    await page.click('.chat-menu__btn[data-cmd="claim"]');
    await page.waitForTimeout(60);
    // 内政
    await page.click('.chat-menu__btn[data-cmd="domestic"]');
    await waitFor(page, '.chat-opt[data-kind]');
    const kinds = await page.$$eval('.chat-opt[data-kind]', (els) => els.map((e) => e.dataset.kind));
    await page.click(`.chat-opt[data-kind="${kinds[i % kinds.length]}"]`);
    await page.waitForTimeout(60);
    // render() でトークが消えない
    const n0 = await page.$$eval('.chat-log > li', (e) => e.length);
    await page.evaluate(async () => (await import('/js/main.js')).render());
    const n1 = await page.$$eval('.chat-log > li', (e) => e.length);
    if (i === 0) {
      check(`${tag}: render() でトークが消えない`, n0 === n1 && n0 > 0, `${n0} -> ${n1}`);
      await shot(page, `${tag}-chat-talk`);
      await screenOk(page, 'Chat トーク');
    }
    await page.click('.chat-head__back');
    await waitFor(page, '.chat--list');
  }
}

/**
 * 砦を落とす場面を作る（テストのためだけ。ページの state を直接いじる）:
 * 自分の部隊を Rare 砦の隣に置き、兵を増やして探索済みにする。そのあとは Chat の「戦闘」で指示する。
 * 次のターンの頭に SOUL とエクステンションの選択待ちが出るので、Drive / Photo を通れる。
 */
async function stageSiege(page, tag) {
  const sid = await page.evaluate(async () => {
    const app = (await import('/js/main.js')).getApp();
    const { neighbors } = await import('/js/engine/hex.js');
    const { stepCost } = await import('/js/engine/pathfind.js');
    const st = app.state;
    const { w, h } = st.map;
    const me = st.lands[st.playerLand];
    const squads = Object.values(st.squads).filter((s) => s.land === st.playerLand && s.status !== 'routed');
    const fortTiles = new Set(Object.values(st.forts).map((f) => f.tile));
    const busy = new Set(Object.values(st.squads).map((s) => s.tile));
    // Legendary を落とすとクリアで終わるので、Rare → Epic の順に探す
    const forts = Object.values(st.forts).filter((f) => f.owner === 'enemy' && f.rank !== 'legendary')
      .sort((a, b) => (a.rank === 'rare' ? 0 : 1) - (b.rank === 'rare' ? 0 : 1));
    for (const sq of squads.slice(1).concat(squads.slice(0, 1))) {
      const hero = app.db.heroes[sq.heroId] || app.db.heroes[String(sq.heroId)];
      for (const f of forts) {
        for (const n of neighbors(f.tile, w, h)) {
          if (fortTiles.has(n) || busy.has(n)) continue;
          if (!Number.isFinite(stepCost(st, app.db, sq, hero, n))) continue;
          sq.tile = n;
          sq.orders = [];
          sq.troops = 2000;
          const ex = new Set(me.explored || []);
          ex.add(n); ex.add(f.tile);
          for (const k of neighbors(n, w, h)) ex.add(k);
          me.explored = [...ex];
          return sq.id;
        }
      }
    }
    return null;
  });
  check(`${tag}: 砦の隣に部隊を置ける（テスト用の仕込み）`, !!sid);
  if (!sid) return;
  await page.evaluate(async (id) => (await import('/js/main.js')).go('chat', { squad: id }), sid);
  await waitFor(page, '.chat--talk');
  await page.click('.chat-menu__btn[data-cmd="attack"]');
  await page.waitForTimeout(80);
  const opt = await page.$('.chat-opt[data-target]');
  check(`${tag}: Chat の「戦闘」に射程内の砦が出る`, !!opt);
  if (opt) await opt.click();
  await shot(page, `${tag}-chat-attack`);
  const queued = await page.evaluate(async (id) => (await import('/js/main.js')).getApp().state.squads[id].orders.some((o) => o.type === 'attack'), sid);
  check(`${tag}: 攻撃が積まれる`, queued);
  await page.evaluate(async () => (await import('/js/main.js')).go('home'));
  await waitFor(page, '.home');
}

async function oneTurn(page, tag, opts = {}) {
  await waitFor(page, '.home');
  await handlePending(page, tag);
  if (!(await page.$('.home'))) {
    await page.evaluate(async () => (await import('/js/main.js')).go('home'));
    await waitFor(page, '.home');
  }
  const day = await page.evaluate(async () => (await import('/js/main.js')).getApp().state.day);
  await shot(page, `${tag}-home`);
  await screenOk(page, 'ホーム');
  if (opts.siege) await stageSiege(page, tag);
  await giveOrders(page, tag);
  // Map からターン終了
  await page.evaluate(async () => (await import('/js/main.js')).go('map'));
  await waitFor(page, '.map-app__end');
  await page.click('.map-app__end');
  // 選択待ちが残っていれば誘導される
  for (let g = 0; g < 4; g++) {
    if (await page.$('.execbar__skip')) break;
    await page.waitForTimeout(300);
    if (await page.$('.execbar__skip')) break;
    const pa = await page.evaluate(async () => (await import('/js/main.js')).pendingApp());
    if (pa) {
      await handlePending(page, tag);
      await page.evaluate(async () => (await import('/js/main.js')).endTurn());
    }
  }
  await waitFor(page, '.execbar__skip');
  await page.waitForTimeout(1200);
  await shot(page, `${tag}-execute`);
  await screenOk(page, '実行フェーズ');
  await page.click('.execbar__skip');
  await page.waitForSelector('.home, .result', { timeout: 20000 });
  const after = await page.evaluate(async () => { const a = (await import('/js/main.js')).getApp(); return { day: a.state.day, ended: !!a.state.ended }; });
  check(`${tag}: ターンが進む`, after.ended || after.day === day + 1, `day ${day} -> ${after.day}`);
  return after;
}

async function visitApps(page, tag) {
  for (const a of ['calendar', 'drive', 'photo', 'map']) {
    await page.evaluate(async (x) => (await import('/js/main.js')).go(x), a);
    await page.waitForTimeout(200);
    await shot(page, `${tag}-${a}`);
    await screenOk(page, a);
  }
  // Drive のタブ
  await page.evaluate(async () => (await import('/js/main.js')).go('drive'));
  for (const k of ['forts', 'lands']) {
    await page.click(`#drive-tab-${k}`);
    await page.waitForTimeout(100);
    await shot(page, `${tag}-drive-${k}`);
    await screenOk(page, `Drive ${k}`);
  }
  await page.evaluate(async () => (await import('/js/main.js')).go('home'));
}

// ------------------------------------------------------------
// 本体
// ------------------------------------------------------------

async function newPage(browser, viewport, url) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, hasTouch: viewport.width < 600 });
  await routeAssets(context);
  const page = await context.newPage();
  const label = `${viewport.width}x${viewport.height}`;
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const loc = m.location() && m.location().url;
    if (/Failed to load resource/.test(m.text()) && loc && /raw\.githubusercontent\.com/.test(loc)) {
      results.missingAssets.add(loc);
      return;
    }
    results.errors.push(`[${label}] console: ${m.text()}${loc ? ` (${loc})` : ''}`);
  });
  page.on('pageerror', (e) => results.errors.push(`[${label}] pageerror: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 400 && /raw\.githubusercontent\.com/.test(r.url())) results.missingAssets.add(r.url());
    else if (r.status() >= 400) results.errors.push(`[${label}] HTTP ${r.status()} ${r.url()}`);
  });
  await page.goto(url);
  return { context, page };
}

async function pickLand(page, tag) {
  await waitFor(page, '.land-card');
  await page.waitForTimeout(300);
  await shot(page, `${tag}-land`);
  await screenOk(page, 'ランド選択');
  const cards = await page.$$('.land-card');
  check(`${tag}: ランドが 9 枚`, cards.length === 9, String(cards.length));
  await cards[4].click();
  await waitFor(page, '.home');
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const pw = await loadPlaywright();
  const server = await startServer();
  const browser = await pw.chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    // ---------- 390x844 ----------
    const { context, page } = await newPage(browser, { width: 390, height: 844 }, server.url);
    await pickLand(page, 'p');

    // 設定のポップアップと Esc / 重なり
    await page.click('.home__settings');
    await waitFor(page, '.popup');
    await shot(page, 'p-settings');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(80);
    check('設定のポップアップが Esc で閉じる', (await page.$$('.popup')).length === 0);
    await page.click('.home__settings');
    await page.evaluate(async () => (await import('/js/main.js')).confirmPopup('test', () => {}));
    check('ポップアップは同時に 1 つだけ', (await page.$$('.popup')).length === 1);
    await page.keyboard.press('Escape');

    for (let n = 1; n <= TURNS; n++) {
      const r = await oneTurn(page, `p-t${n}`, { siege: n === 3 });
      if (n === 1) await visitApps(page, 'p-t1');
      if (n === 2) {
        // セーブして再読み込み → 続きから
        const before = await page.evaluate(async () => { const a = (await import('/js/main.js')).getApp(); return { day: a.state.day, seed: a.state.seed }; });
        await page.reload();
        await waitFor(page, '.home');
        const after = await page.evaluate(async () => { const a = (await import('/js/main.js')).getApp(); return { day: a.state.day, seed: a.state.seed }; });
        check('再読み込みで続きから始まる', before.day === after.day && before.seed === after.seed, `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
      }
      if (r.ended) break;
    }

    // 28 日目まで進めて結果画面
    await page.evaluate(async () => { const m = await import('/js/main.js'); const a = m.getApp(); a.state.day = 27; m.go('home'); });
    for (let g = 0; g < 4; g++) {
      if (await page.$('.result')) break;
      await handlePending(page, 'p-end');
      await page.evaluate(async () => (await import('/js/main.js')).go('home'));
      await waitFor(page, '.home__end');
      await page.click('.home__end');
      await page.waitForTimeout(300);
      if (await page.$('.execbar__skip')) await page.click('.execbar__skip');
      await page.waitForSelector('.home, .result, .soul-card, .swipe', { timeout: 20000 });
    }
    const hasResult = !!(await page.$('.result'));
    check('28 日目を越えると結果画面が出る', hasResult);
    if (hasResult) {
      await page.waitForTimeout(1600);
      await shot(page, 'p-result');
      await screenOk(page, '結果');
      await page.reload();
      await page.waitForSelector('.result, .home', { timeout: 10000 });
      check('終わったセーブを読むと結果画面', !!(await page.$('.result')));
      await page.click('.result__actions .btn-primary');
      await waitFor(page, '.land-card');
      check('もう一度でランド選択へ', true);
    }
    check('砦を落として SOUL（Drive）とエクステンション（Photo）の選択を通れた', results.pendingSeen.has('drive') && results.pendingSeen.has('photo'), [...results.pendingSeen].join(','));
    await context.close();

    // ---------- 1280x800 ----------
    const wide = await newPage(browser, { width: 1280, height: 800 }, server.url);
    await pickLand(wide.page, 'w');
    await oneTurn(wide.page, 'w-t1');
    await wide.page.evaluate(async () => (await import('/js/main.js')).go('map'));
    await wide.page.waitForTimeout(300);
    await shot(wide.page, 'w-t2-map');
    await screenOk(wide.page, 'Map 1280');
    await wide.context.close();
  } finally {
    await browser.close();
    server.child.kill();
  }

  check('Console エラーと pageerror が 0', results.errors.length === 0, results.errors.slice(0, 10).join(' | '));
  const failed = results.checks.filter((c) => !c.ok);
  console.log('');
  console.log(`checks: ${results.checks.length - failed.length}/${results.checks.length} ok`);
  console.log(`screenshots: ${results.shots.length} -> ${SHOTS}`);
  if (results.missingAssets.size) console.log(`画像が無い（手元の clone にも無い / 取れない）: ${results.missingAssets.size} 件  例: ${[...results.missingAssets].slice(0, 3).join(' ')}`);
  for (const e of results.errors) console.log(`  ${e}`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
