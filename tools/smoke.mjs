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
// 文言のキーの頭（ui の "chat.ng.ap" なら chat）。画面にキーがそのまま出ていないかを見るのに使う
const KEY_PREFIXES = [...new Set(Object.keys(JSON.parse(readFileSync(join(ROOT, 'data', 'messages.json'), 'utf8')).ui || {}).map((k) => k.split('.')[0]))]
  .filter((k) => /^[A-Za-z][A-Za-z0-9_]*$/.test(k)).sort((x, y) => y.length - x.length).join('|');
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
  const info = await page.evaluate((KEY_PREFIXES) => {
    const screen = document.querySelector('.phone__screen');
    const txt = document.body.innerText || '';
    return {
      children: screen ? screen.children.length : 0,
      broken: !!document.querySelector('.phone__screen .app-screen p.muted') && /この画面を描けませんでした/.test(txt),
      popups: document.querySelectorAll('.popup').length,
      emoji: [...txt].filter((c) => /\p{Extended_Pictographic}/u.test(c)).join(''),
      words: (txt.match(/\b(unit|units|gold|Gold|ユニット|ゴールド)\b/g) || []).join(','),
      rawKeys: (txt.match(new RegExp(`\\b(?:${KEY_PREFIXES})\\.[A-Za-z0-9_]+(?:\\.[A-Za-z0-9_]+)*`, 'g')) || []).join(','),
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  }, KEY_PREFIXES);
  // 文言のキーがそのまま出ていない（messages.json に無いキーを引くと、キーの文字列が画面に出る）
  const ok = info.children > 0 && !info.broken && info.popups <= 1 && !info.emoji && !info.words && !info.rawKeys && !info.overflowX;
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
      // 裏向きの 3 枚が順にめくれ終わってから選ぶ（SPEC-112 §5。裏向きのうちに押すと全部めくれるだけ）
      await waitFor(page, '.soul.is-ready .soul-card');
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
  // Map: 砦をタップすると攻撃の見込みが出る（SPEC-114 §5・§9）。並ぶ数字は battle.predict と同じ
  await page.evaluate(async (id) => {
    const m = await import('/js/main.js');
    const { neighbors } = await import('/js/engine/hex.js');
    const app = m.getApp();
    const st = app.state;
    const sq = st.squads[id];
    const near = neighbors(sq.tile, st.map.w, st.map.h);
    const f = Object.values(st.forts).find((x) => x.owner !== sq.land && near.includes(x.tile));
    app.ui.selectedSquad = id;
    app.ui.tile = f ? f.tile : null;
    m.go('map');
  }, sid);
  await page.waitForSelector('.map-pred', { timeout: 5000 }).catch(() => {});
  const pred = await page.$eval('.map-pred', (e) => ({
    label: e.dataset.label,
    rows: [...e.querySelectorAll('.map-pred__row')].map((r) => r.textContent),
    note: (e.querySelector('.map-pred__note') || {}).textContent || '',
  })).catch(() => null);
  check(`${tag}: Map で敵の砦をタップすると攻撃の見込み（自 / 敵 / 耐久の「前 → 幅」とラベル）が出る`,
    !!pred && pred.rows.length >= 3 && pred.rows.every((r) => /→/.test(r)) && !!pred.label && /運/.test(pred.note), JSON.stringify(pred));
  const same = await page.evaluate(async (id) => {
    const m = await import('/js/main.js');
    const { predict } = await import('/js/engine/battle.js');
    const { targetAt } = await import('/js/engine/turn.js');
    const app = m.getApp();
    const sq = app.state.squads[id];
    const target = app.ui.tile != null ? targetAt(app.state, sq.land, app.ui.tile) : null;
    const row = document.querySelector('.map-pred__row.is-self');
    if (!target || !row) return false;
    const p = predict(app.state, app.db, sq, target);
    return Number(row.dataset.before) === p.attacker.before && Number(row.dataset.min) === p.attacker.min && Number(row.dataset.max) === p.attacker.max
      && document.querySelector('.map-pred').dataset.label === p.label;
  }, sid);
  check(`${tag}: 攻撃の見込みの数字は battle.predict のまま（UI で計算し直さない）`, same);
  await page.waitForTimeout(900); // アプリが開く動きが終わってから撮る
  await shot(page, `${tag}-map-predict`);
  await page.evaluate(async () => { const a = (await import('/js/main.js')).getApp(); a.ui.tile = null; });
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
  if (opts.siege) {
    // Chat から積んだ攻撃にも、実行の前に見込みが控えてあり、戦闘の結果に「予想 → 実際」が並ぶ（SPEC-114 §5）
    const kept = await page.evaluate(async () => { const a = (await import('/js/main.js')).getApp(); return a.ui.mapPred ? Object.keys(a.ui.mapPred.list) : []; });
    check(`${tag}: 実行の前に、攻撃の指示の見込みが控えてある`, kept.length > 0, kept.join(','));
    const card = await page.waitForSelector('.map-result[data-pred="1"]', { timeout: 25000 }).then((e) => e.textContent()).catch(() => null);
    check(`${tag}: 実行フェーズの戦闘の結果に「予想 … → 実際 …」が出る`, !!card && /予想/.test(card) && /実際/.test(card), card || '');
    if (card) await shot(page, `${tag}-execute-result`);
  }
  await page.waitForTimeout(1200);
  await shot(page, `${tag}-execute`);
  await screenOk(page, '実行フェーズ');
  await page.click('.execbar__skip');
  await page.waitForSelector('.home, .result', { timeout: 20000 });
  const after = await page.evaluate(async () => { const a = (await import('/js/main.js')).getApp(); return { day: a.state.day, ended: !!a.state.ended }; });
  check(`${tag}: ターンが進む`, after.ended || after.day === day + 1, `day ${day} -> ${after.day}`);
  return after;
}

/**
 * ホームの情報（SPEC-114 §2・§3・§7。§9 の確かめ方のうちホーム班の分）:
 * 朝の報告が出る / 資源のウィジェットに「/日」と（赤字なら）「あと N 日」/ 内訳シートの行の合計が差し引きと一致 /
 * 配給を切り替えると見込みが変わる / 主役ボタンの上の要約 / 食料が今夜尽きるなら 1 回目は内訳、2 回目で進む
 */
async function homeInfoChecks(page, tag) {
  await page.evaluate(async () => (await import('/js/main.js')).go('home'));
  await waitFor(page, '.home');
  check(`${tag}: 朝の報告が出る`, !!(await page.$('.home .morning')));
  // 朝の報告の兵の行（SPEC-114 §2.1）: 主文の ±N は兵のウィジェットの前日差（実行前の控え → いま）と同じで、
  // 理由ごとの内訳を足すと ±N になる（「戦闘・回復」のような残りの行を作らない）
  const mt = await page.evaluate(async () => {
    const a = (await import('/js/main.js')).getApp();
    const m = a.state.morning;
    if (!m) return null;
    const row = m.rows.find((r) => r.kind === 'troops' || r.kind === 'desert');
    const num = (x) => Number(String(x).replace(/[,\s]/g, '').replace('−', '-').replace('±', ''));
    const parts = row ? [...row.why.matchAll(/([+−±][\d,]+)/g)].map((x) => num(x[1])) : [];
    const shown = row ? num(row.main.replace(/^[^+−±]*/, '')) : null;
    return { check: m.check, shown, parts, why: row ? row.why : '', main: row ? row.main : '' };
  });
  check(`${tag}: 朝の報告の兵の ±N が兵のウィジェットの前日差と一致し、内訳の合計も一致`,
    !!mt && mt.check.diff === mt.check.troops - mt.check.base
      && (mt.shown == null || (mt.shown === mt.check.diff && mt.parts.reduce((x, y) => x + y, 0) === mt.check.diff && !/戦闘・回復/.test(mt.why))),
    JSON.stringify(mt));
  // 朝の報告と今日のやることが出ていても、アプリの列は下の帯に潜らない（Map のアイコンの中心が押せる）
  const lay = await page.evaluate(() => {
    const ic = document.querySelector('.home .app-icon[data-app="map"] .app-icon__tile');
    if (!ic) return { hit: null };
    const r = ic.getBoundingClientRect();
    const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { hit: el && el.closest('.app-icon') ? 'icon' : el ? el.className : null, todo: document.querySelectorAll('.home .todo').length, rows: document.querySelectorAll('.home .morning .mrow').length };
  });
  check(`${tag}: アプリの列が下の帯に潜らない・今日のやることは 2 件まで・朝の報告は 2 行まで`, lay.hit === 'icon' && lay.todo <= 2 && lay.rows <= 2, JSON.stringify(lay));
  const w = await page.evaluate(async () => {
    const m = await import('/js/main.js');
    const eco = await import('/js/engine/economy.js');
    const a = m.getApp();
    const st = a.state;
    const b = eco.forecast(st, a.db, st.playerLand);
    const out = [];
    for (const k of ['gum', 'food', 'mat', 'pop']) {
      const el = document.querySelector(`.res[data-res="${k}"]`);
      out.push({ k, delta: el ? el.querySelector('.res__delta').textContent : null, warn: !!(el && el.querySelector('.res__warn')), net: b[k].net, days: b[k].daysLeft });
    }
    return { out, troops: !!document.querySelector('.troops-w .morale'), sum: (document.querySelector('.home__sum') || {}).textContent || '' };
  });
  check(`${tag}: 資源のウィジェットに「/日」`, w.out.every((x) => x.delta && x.delta.endsWith('/日')), JSON.stringify(w.out.map((x) => x.delta)));
  const due = w.out.filter((x) => x.k !== 'pop' && x.days != null && x.days <= 2);
  check(`${tag}: 2 日以内に尽きる資源に「あと N 日」`, due.every((x) => x.warn), JSON.stringify(due));
  check(`${tag}: 兵と士気のウィジェット`, w.troops);
  check(`${tag}: 主役ボタンの上に要約（食料・士気・未指示）`, /\/日/.test(w.sum) && /士気/.test(w.sum) && /未指示/.test(w.sum), w.sum);
  // 内訳シート: どのタブも、行の合計 = 差し引き
  await page.click('.res[data-res="food"]');
  await waitFor(page, '.popup--sheet .ledger');
  await shot(page, `${tag}-ledger-food`);
  const sums = [];
  for (const k of ['food', 'gum', 'mat', 'pop']) {
    await page.click(`.ledger__tab[data-tab="${k}"]`);
    await page.waitForTimeout(60);
    sums.push(await page.evaluate(() => {
      const l = document.querySelector('.popup--sheet .ledger');
      let sum = 0;
      for (const v of l.querySelectorAll('.ledger-row__val')) sum += Number(v.dataset.v);
      return { tab: l.dataset.tab, sum, net: Number(l.dataset.net) };
    }));
  }
  check(`${tag}: 内訳シートの行の合計が差し引きと一致`, sums.every((x) => x.sum === x.net), JSON.stringify(sums));
  // 配給を切り替えると見込みが変わる（節約は兵の食料が減る）
  await page.click('.ledger__tab[data-tab="food"]');
  await page.waitForTimeout(60);
  const before = await page.evaluate(() => Number(document.querySelector('.popup--sheet .ledger').dataset.net));
  const expect = await page.evaluate(() => Number(document.querySelector('.ledger-ration__opt[data-ration="save"]').dataset.food));
  await page.click('.ledger-ration__opt[data-ration="save"]');
  await page.waitForTimeout(80);
  const after = await page.evaluate(async () => ({ net: Number(document.querySelector('.popup--sheet .ledger').dataset.net), ration: (await import('/js/main.js')).getApp().state.lands[(await import('/js/main.js')).getApp().state.playerLand].ration }));
  check(`${tag}: 配給を「節約」にすると見込みが previewRation どおりに変わる`, after.ration === 'save' && after.net === expect && after.net >= before, `${before} -> ${after.net}（見込み ${expect}）`);
  await page.click('.ledger-ration__opt[data-ration="normal"]');
  await page.click('.ledger__tab[data-tab="troops"]');
  await page.waitForTimeout(80);
  await shot(page, `${tag}-ledger-troops`);
  check(`${tag}: 兵と士気のタブに部隊ごとの士気`, (await page.$$('.ledger-squad .morale')).length >= 1);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  // 食料が今夜尽きる見込み: 1 回目は内訳シート、2 回目で進む（写しで試して、元に戻す）
  const saved = await page.evaluate(async () => {
    const m = await import('/js/main.js');
    const a = m.getApp();
    const st = a.state;
    const me = st.lands[st.playerLand];
    const keep = { food: me.res.food, done: { ...(a.ui.orderDone || {}) } };
    me.res.food = 0;
    for (const s of Object.values(st.squads)) if (s.land === st.playerLand) { a.ui.orderDone = { ...(a.ui.orderDone || {}), [s.id]: st.day }; }
    m.go('home');
    return keep;
  });
  await waitFor(page, '.home__end');
  const label = await page.$eval('.home__end', (e) => e.textContent);
  check(`${tag}: 食料が今夜尽きるなら主役ボタンが「食料が今夜尽きます」`, /今夜尽きます|今夜 食料切れ/.test(label), label);
  const day0 = await page.evaluate(async () => (await import('/js/main.js')).getApp().state.day);
  await page.click('.home__end');
  await page.waitForTimeout(300);
  const opened = !!(await page.$('.popup--sheet .ledger[data-tab="food"]'));
  const day1 = await page.evaluate(async () => (await import('/js/main.js')).getApp().state.day);
  check(`${tag}: 1 回目は内訳シート（食料）を開くだけ`, opened && day1 === day0 && !(await page.$('.execbar__skip')));
  await shot(page, `${tag}-starve-sheet`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  const label2 = await page.$eval('.home__end', (e) => e.textContent);
  check(`${tag}: 2 回目は「それでも進める」`, /それでも進める/.test(label2), label2);
  // 進めずに元へ戻す（通しの続きは oneTurn が進める）
  await page.evaluate(async (keep) => {
    const m = await import('/js/main.js');
    const a = m.getApp();
    a.state.lands[a.state.playerLand].res.food = keep.food;
    a.ui.orderDone = keep.done;
    a.ui.starveAck = null;
    m.go('home');
  }, saved);
  await waitFor(page, '.home');
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
  await driveInfoChecks(page, tag);
  await page.evaluate(async () => (await import('/js/main.js')).go('home'));
}

/**
 * Drive の情報（SPEC-114 §6・§9）: 順位表が出る（全ランド・自分の行・初めは砦 pt と兵の 2 列・並べ替えで切り替わる）/
 * 視界外のランドは「?」で値を持たない / 値は朝の時点で固定（同じ日のうちに state が動いても表は変わらない）/
 * ヒーローのカードに士気のゲージと食費（economy.breakdown の部隊ごとの行と同じ値）。順位表のタブを開いた状態で呼ぶ。
 */
async function driveInfoChecks(page, tag) {
  const rank = await page.evaluate(async () => {
    const a = (await import('/js/main.js')).getApp();
    const { totalTroops } = await import('/js/engine/economy.js');
    const st = a.state;
    const rows = [...document.querySelectorAll('.rank-table tbody tr')];
    const heads = [...document.querySelectorAll('.rank-table thead th')].map((th) => th.textContent.trim());
    const known = rows.filter((r) => !r.classList.contains('is-unknown'));
    const unknown = rows.filter((r) => r.classList.contains('is-unknown'));
    // 見えているランドの兵は「あなたに見えている分」（探索済みのタイルにいる部隊の兵の合計。初めの表示は 4 列目が兵）。
    // 全部見えているランドと自ランドは totalTroops と同じで「〜」が無い。一部だけなら「〜」と最後に見た日が付く
    const seen = new Set(st.lands[st.playerLand].explored || []);
    const troopsCheck = known.map((r) => {
      const id = r.dataset.land;
      const v = r.children[3].querySelector('.rank-v');
      const n = v ? Number(v.textContent.replace(/[^0-9]/g, '')) : NaN;
      const part = !!(v && v.classList.contains('is-part'));
      const sq = Object.values(st.squads).filter((s) => s.land === id);
      const vis = sq.filter((s) => seen.has(s.tile));
      const visSum = vis.reduce((x, s) => x + (s.troops || 0), 0);
      const day = (r.children[3].querySelector('.rank-v__seen') || {}).textContent || '';
      let ok;
      if (id === st.playerLand) ok = !part && n === totalTroops(st, id);
      else if (vis.length && vis.length === sq.length) ok = !part && n === visSum;
      else if (vis.length) ok = part && /〜/.test(v.textContent) && n === visSum && /きょう/.test(day);
      // きょうは部隊が 1 つも見えない: 前に見た値なら「〜」と日付、一度も見ていなければ「?」（脱落したランドは 0）
      else if (!v) ok = !!r.children[3].querySelector('.rank-q');
      else ok = part ? /日前|きょう/.test(day) : (st.lands[id].alive === false && n === 0);
      return { id, n, part, visSum, vis: vis.length, all: sq.length, day, ok };
    });
    const troopsOk = troopsCheck.every((x) => x.ok);
    return {
      n: rows.length, lands: (a.db.lands || []).filter((l) => st.lands[l.id]).length, heads,
      me: rows.filter((r) => r.classList.contains('is-me')).length, meLand: (rows.find((r) => r.classList.contains('is-me')) || {}).dataset?.land === st.playerLand,
      sum: !!document.querySelector('.rank-sum'), sortBtns: document.querySelectorAll('.rank__sort-btn').length,
      unknownQ: unknown.every((r) => r.querySelectorAll('.rank-q').length >= 1 && !/[0-9]/.test(r.children[3].textContent)), unknownN: unknown.length,
      troopsOk, troopsCheck,
    };
  });
  check(`${tag}: Drive の順位表が出る（全ランド・自分の行が 1 つ・初めは「砦 pt」と「兵」の 2 列・自分の順位の行）`,
    rank.n === rank.lands && rank.me === 1 && rank.meLand && rank.sum && rank.sortBtns === 3 && /砦/.test(rank.heads[2]) && /兵/.test(rank.heads[3]), JSON.stringify(rank));
  check(`${tag}: 順位表: 視界外のランドは「?」で数を出さない・よそのランドの兵は見えている分（一部だけなら「〜」と最後に見た日）`, rank.unknownQ && rank.troopsOk, JSON.stringify({ unknownN: rank.unknownN, troops: rank.troopsCheck }));
  await page.click('.rank__sort-btn[data-view="troops"]');
  await page.waitForTimeout(150);
  const fixed = await page.evaluate(async () => {
    const m = await import('/js/main.js');
    const a = m.getApp();
    const st = a.state;
    const view = document.querySelector('.rank-table').dataset.view;
    // 見えている部隊のあるよそのランド（その兵を動かしても、同じ日のうちは表が変わらないこと）
    const seen = new Set(st.lands[st.playerLand].explored || []);
    const visible = (id) => Object.values(st.squads).find((s) => s.land === id && seen.has(s.tile));
    const row = [...document.querySelectorAll('.rank-table tbody tr')].find((r) => !r.classList.contains('is-me') && !r.classList.contains('is-unknown') && visible(r.dataset.land));
    if (!row) return { view, skipped: true, same: true };
    const sq = visible(row.dataset.land);
    const before = row.textContent;
    sq.troops += 321;
    m.render();
    await new Promise((r) => setTimeout(r, 50));
    const after = (document.querySelector(`.rank-table tbody tr[data-land="${row.dataset.land}"]`) || {}).textContent;
    sq.troops -= 321;
    m.render();
    return { view, same: before === after, before, after };
  });
  check(`${tag}: 順位表: 並べ替えで「兵」に切り替わり、値は朝の時点で固定（同じ日のうちは動かない）`, fixed.view === 'troops' && fixed.same, JSON.stringify(fixed));
  await shot(page, `${tag}-drive-rank-troops`);
  await page.click('.rank__sort-btn[data-view="fp"]');
  await page.click('#drive-tab-heroes');
  await page.waitForTimeout(150);
  const cards = await page.evaluate(async () => {
    const a = (await import('/js/main.js')).getApp();
    const { breakdown } = await import('/js/engine/economy.js');
    const st = a.state;
    const rows = new Map(breakdown(st, a.db, st.playerLand).food.expense.filter((r) => r.key === 'troops').map((r) => [r.squad, r.value]));
    return [...document.querySelectorAll('.hero-card')].map((c) => {
      const sq = st.squads[c.dataset.squad];
      const food = (c.querySelector('.hero-card__food b') || {}).textContent || '';
      const mor = (c.querySelector('.hero-card__sum .morale__num') || {}).textContent;
      const want = rows.get(sq.id) || 0;
      return { id: sq.id, food, mor, ok: Number(mor) === sq.morale && Number(food.replace(/[^0-9]/g, '')) === want && (want === 0 ? /±0/.test(food) : /[−-]/.test(food)) };
    });
  });
  check(`${tag}: Drive のヒーローのカードに士気（数字つきゲージ）と食費 −N/日（breakdown の部隊ごとの行）`, cards.length > 0 && cards.every((c) => c.ok), JSON.stringify(cards));
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

/**
 * Chat の情報（SPEC-114 §4・§9）: 内政のボタンに見込みが出て、押しても閉じず続けて積める / 「このあと」/ 見出しの士気と食費 /
 * 「1 手戻す」で AP が戻る。農作を 1 回積んだ直後のトークで呼ぶ（戻ったときも農作 1 回が積まれたまま）。
 */
async function chatInfoChecks(fp, sid) {
  const state = () => fp.evaluate(async (id) => { const s = (await import('/js/main.js')).getApp().state.squads[id]; return { ap: s.ap, n: s.orders.length }; }, sid);
  await fp.waitForTimeout(300);
  await shot(fp, 'f-chat-domestic'); // 内政のシートが開いたまま（見込みと ×1）
  const dom = await fp.$$eval('.chat-dom', (els) => els.map((e) => ({ kind: e.dataset.kind, ok: e.dataset.ok, eff: e.querySelectorAll('.chat-eff').length, foot: (e.querySelector('.chat-dom__foot') || {}).textContent || '' })));
  check('chat: 内政のボタン 5 つに見込みと「あと N 回 / できない理由」が出る', dom.length === 5 && dom.every((d) => d.eff > 0 && d.foot), JSON.stringify(dom.map((d) => `${d.kind}:${d.foot}`)));
  const farm = await fp.$eval('.chat-dom[data-kind="farm"]', (e) => ({ count: e.dataset.count, text: (e.querySelector('.chat-dom__count') || {}).textContent || '' })).catch(() => null);
  check('chat: 内政を押してもシートが閉じず、積んだ回数「×1」が出る', !!farm && farm.count === '1' && /1/.test(farm.text), JSON.stringify(farm));
  const after = await fp.$eval('.chat-after', (e) => ({ text: e.textContent, now: Number(e.dataset.now), after: Number(e.dataset.after) })).catch(() => null);
  check('chat: 積んだ指示の帯に「このあと 食料 … /日」が出る（農作で減らない）', !!after && /\/日/.test(after.text) && after.after >= after.now, JSON.stringify(after));
  const head = await fp.$eval('.chat-head__stats', (e) => e.textContent).catch(() => '');
  check('chat: 見出しの帯に士気と食費が出る', /士気\s*\d+/.test(head) && /食費/.test(head) && /\/日/.test(head), head);
  // 続けて積める（AP が足りれば 2 回目）→ 1 手戻すで AP が戻る
  const s0 = await state();
  const ok2 = await fp.$eval('.chat-dom[data-kind="farm"]', (e) => e.dataset.ok === '1').catch(() => false);
  if (ok2) {
    await fp.click('.chat-dom[data-kind="farm"]');
    await fp.waitForTimeout(250);
    const s1 = await state();
    const count = await fp.$eval('.chat-dom[data-kind="farm"]', (e) => e.dataset.count).catch(() => null);
    check('chat: 内政は続けて積める（×2・AP −2）', s1.n === s0.n + 1 && s1.ap === s0.ap - 2 && (count === '2' || s1.ap < 2), `${JSON.stringify(s0)} -> ${JSON.stringify(s1)} count=${count}`);
  }
  const s2 = await state();
  await fp.click('.chat-undo');
  await fp.waitForTimeout(250);
  const s3 = await state();
  check('chat: 「1 手戻す」で最後の指示が外れ AP が戻る', s3.n === s2.n - 1 && s3.ap === s2.ap + 2, `${JSON.stringify(s2)} -> ${JSON.stringify(s3)}`);
  if (s3.n === 0) {
    // 1 回目の農作まで外れたら積み直す（このあとの流れは「指示を積んだ」状態が前提）
    if (!(await fp.$('.chat-dom[data-kind="farm"]'))) await fp.click('.chat-menu__btn[data-cmd="domestic"]');
    await fp.click('.chat-dom[data-kind="farm"]');
    await fp.waitForTimeout(250);
  }
  await shot(fp, 'f-chat-info');
}

/**
 * 古いセーブ（SPEC-113 より前。Squad.morale / Land.ration / state.morning が無い）を localStorage に入れて読み込む（SPEC-113 §6.4）。
 * --old-save <file> があればそのファイル（前の版のコードで作ったセーブ）、無ければいまの state から新しい項目を消して作る。
 * 落ちずにホーム・内訳・Chat・Drive・Map が描け、既定値（士気 60・配給 normal）が入り、ターンが進むこと。
 */
async function oldSaveChecks(browser, url) {
  const ctx = await newPage(browser, { width: 390, height: 844 }, url);
  const op = ctx.page;
  await pickLand(op, 'o');
  const file = argOf('--old-save', null);
  const raw = file ? readFileSync(resolve(file), 'utf8') : null;
  const info = await op.evaluate(async (fromFile) => {
    const m = await import('/js/main.js');
    const { LS_SAVE } = await import('/js/constants.js');
    let s;
    if (fromFile) s = JSON.parse(fromFile);
    else {
      s = JSON.parse(JSON.stringify(m.getApp().state));
      // 前の版の state にあった項目だけ残す（SPEC-110 の Phase 3A までの形）
      const OLD = ['version', 'seed', 'day', 'phase', 'playerLand', 'map', 'lands', 'squads', 'forts', 'builds', 'nextId', 'log', 'notices', 'pending', 'ended'];
      for (const k of Object.keys(s)) if (!OLD.includes(k)) delete s[k];
      for (const sq of Object.values(s.squads)) delete sq.morale;
      for (const l of Object.values(s.lands)) delete l.ration;
    }
    localStorage.setItem(LS_SAVE, JSON.stringify(s));
    return { day: s.day, keys: Object.keys(s).length, morale: Object.values(s.squads).some((q) => 'morale' in q), ration: Object.values(s.lands).some((l) => 'ration' in l), morning: 'morning' in s };
  }, raw);
  check(`古いセーブ: 士気・配給・朝の報告の無いセーブを用意（${file ? 'ファイル' : 'いまの state から消して作る'}）`, !info.morale && !info.ration && !info.morning, JSON.stringify(info));
  await op.reload();
  await op.waitForSelector('.home', { timeout: 10000 }).catch(() => {});
  const loaded = await op.evaluate(async () => {
    const a = (await import('/js/main.js')).getApp();
    const st = a.state;
    if (!st) return null;
    return {
      day: st.day,
      morale: Object.values(st.squads).every((q) => q.morale === 60),
      ration: Object.values(st.lands).every((l) => l.ration === 'normal'),
      home: !!document.querySelector('.home'),
      delta: (document.querySelector('.res[data-res="food"] .res__delta') || {}).textContent || '',
    };
  });
  check('古いセーブ: 読み込んでホームが出る（ランド選択に戻らない）', !!loaded && loaded.home && loaded.day === info.day, JSON.stringify(loaded));
  check('古いセーブ: 士気は 60・配給は normal で読む', !!loaded && loaded.morale && loaded.ration, JSON.stringify(loaded));
  check('古いセーブ: 資源のウィジェットに「/日」', !!loaded && /\/日$/.test(loaded.delta), loaded && loaded.delta);
  await shot(op, 'o-home');
  await screenOk(op, '古いセーブ ホーム');
  await op.click('.troops-w');
  await waitFor(op, '.popup--sheet .ledger');
  await shot(op, 'o-ledger');
  await screenOk(op, '古いセーブ 内訳');
  await op.keyboard.press('Escape');
  await op.waitForTimeout(250);
  for (const a of ['chat', 'drive', 'map', 'calendar', 'photo']) {
    await op.evaluate(async (x) => (await import('/js/main.js')).go(x), a);
    await op.waitForTimeout(200);
    await screenOk(op, `古いセーブ ${a}`);
  }
  // ターンが進む（食料が今夜尽きる見込みなら 1 回目は内訳。2 回目で進む）
  await op.evaluate(async () => (await import('/js/main.js')).go('home'));
  await waitFor(op, '.home__end');
  for (let g = 0; g < 3 && !(await op.$('.execbar__skip')); g++) {
    await handlePending(op, 'o');
    await op.evaluate(async () => (await import('/js/main.js')).go('home'));
    await waitFor(op, '.home__end');
    await op.click('.home__end');
    await op.waitForTimeout(400);
    if (await op.$('.popup')) { await op.keyboard.press('Escape'); await op.waitForTimeout(250); }
  }
  if (await op.$('.execbar__skip')) await op.click('.execbar__skip');
  await op.waitForSelector('.home, .result, .soul-card, .swipe', { timeout: 20000 }).catch(() => {});
  const day2 = await op.evaluate(async () => (await import('/js/main.js')).getApp().state.day);
  check('古いセーブ: 読んだあと 1 日進められる', day2 === info.day + 1, `${info.day} -> ${day2}`);
  await ctx.context.close();
}

/**
 * 士気が低い部隊の見せ方（SPEC-114 §2.2・§3・§5）: 1 部隊を士気 12（動揺）、1 部隊を 0（逃走中）にして、
 * ホームの兵のウィジェット・内訳の兵と士気のタブ・Map の部隊の士気が、色だけでなく言葉で出ること。
 */
async function lowMoraleChecks(page) {
  const ids = await page.evaluate(async () => {
    const m = await import('/js/main.js');
    const a = m.getApp();
    const st = a.state;
    const mine = Object.values(st.squads).filter((s) => s.land === st.playerLand && s.status !== 'routed');
    if (mine[0]) mine[0].morale = 12;
    if (mine[1]) mine[1].morale = 0;
    m.go('home');
    return mine.slice(0, 2).map((s) => s.id);
  });
  await waitFor(page, '.home .troops-w');
  const w = await page.$eval('.home .troops-w', (e) => ({ text: e.textContent, cls: e.className }));
  check('士気: ホームの兵のウィジェットに「逃走中」か「動揺」（言葉つき）', /逃走|動揺/.test(w.text), JSON.stringify(w));
  await shot(page, 'm-home');
  await page.click('.troops-w');
  await waitFor(page, '.popup--sheet .ledger');
  if (!(await page.$('.ledger[data-tab="troops"]'))) await page.click('.ledger__tab[data-tab="troops"]');
  await page.waitForTimeout(100);
  const rows = await page.$$eval('.ledger-squad', (els) => els.map((e) => ({ id: e.dataset.squad, state: (e.querySelector('.ledger-squad__state') || {}).textContent || '', lv: (e.querySelector('.morale') || {}).className || '' })));
  const r0 = rows.find((r) => r.id === ids[0]);
  const r1 = rows.find((r) => r.id === ids[1]);
  // 士気 12 でも今夜 0 まで下がる見込み（飢えなど）なら、行の言葉は「逃走 今夜 −N 人」が先に出る
  check('士気: 内訳の兵と士気のタブで、士気 12 は「動揺」（今夜逃げるなら逃走）、士気 0 は逃走の言葉', !!r0 && /is-shaken/.test(r0.lv) && /動揺|逃走/.test(r0.state) && !!r1 && /逃/.test(r1.state), JSON.stringify(rows));
  await shot(page, 'm-ledger-troops');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  // Map: 選んだ部隊の札に士気（ゲージ・数字・20 未満は言葉）。動揺と逃走中を 1 つずつ選んで見る
  const chipOf = async (id) => {
    await page.evaluate(async (x) => { const m = await import('/js/main.js'); m.getApp().ui.selectedSquad = x; m.getApp().ui.tile = null; m.go('map'); }, id);
    await page.waitForTimeout(400);
    return page.$$eval('.map-mor', (els) => els.map((e) => ({ m: e.dataset.morale, cls: e.className, w: (e.querySelector('.map-mor__w') || {}).textContent || '' })));
  };
  const shaken = await chipOf(ids[0]);
  const zero = await chipOf(ids[1]);
  check('士気: Map の部隊の士気に 20 未満は「動揺」、0 は「逃走中」',
    shaken.some((c) => c.m === '12' && /is-shaken/.test(c.cls) && /動揺/.test(c.w)) && zero.some((c) => c.m === '0' && /is-zero/.test(c.cls) && /逃走中/.test(c.w)), JSON.stringify({ shaken, zero }));
  await shot(page, 'm-map');
  await screenOk(page, 'Map 士気が低い部隊');
  await page.evaluate(async () => (await import('/js/main.js')).go('home'));
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
      if (n === 1 && !r.ended) await homeInfoChecks(page, 'p-t1');
      if (n === 2) {
        // セーブして再読み込み → 続きから
        const before = await page.evaluate(async () => { const a = (await import('/js/main.js')).getApp(); return { day: a.state.day, seed: a.state.seed, morning: document.querySelectorAll('.home .morning .mrow').length }; });
        await page.reload();
        await waitFor(page, '.home');
        const after = await page.evaluate(async () => { const a = (await import('/js/main.js')).getApp(); return { day: a.state.day, seed: a.state.seed, morning: document.querySelectorAll('.home .morning .mrow').length }; });
        check('再読み込みで続きから始まる', before.day === after.day && before.seed === after.seed, `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
        check('再読み込みしても朝の報告が消えない（state.morning に保存）', before.morning === after.morning, `${before.morning} -> ${after.morning}`);
      }
      if (r.ended) break;
    }

    // 士気が低い部隊（SPEC-114 §2.2・§3・§5）
    if (!(await page.$('.result'))) await lowMoraleChecks(page);

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

    // ---------- 対象 → 指示 → 指示終了 の流れ（SPEC-112 §7.5.3） ----------
    // ロスターと主役ボタン（指示を終える → 次のヒーローへ）だけで全員に指示し、ターン終了まで行けるか
    {
      const flow = await newPage(browser, { width: 390, height: 844 }, server.url);
      const fp = flow.page;
      await pickLand(fp, 'f');
      // 人口 0 の日（徴兵は積めない）でも、内政のメニューは開けて農作は積める（徴兵だけで判定しない）
      await fp.evaluate(async () => { const m = await import('/js/main.js'); const a = m.getApp(); a.state.lands[a.state.playerLand].res.pop = 0; m.render(); });
      await fp.click('.app-icon[data-app="chat"]');
      await fp.waitForSelector('.chat--list, .chat--talk', { timeout: 10000 });
      if (await fp.$('.chat--list')) {
        await fp.click('.chat-primary');
        await waitFor(fp, '.chat--talk');
      }
      const total = await fp.$$eval('.chat-roster__btn', (els) => els.length);
      check('flow: Chat のトークにロスターが出る', total >= 3, `${total} 人`);
      const visited = new Set();
      let reachedEnd = false;
      for (let k = 0; k < total + 2; k++) {
        const cur = await fp.$eval('.chat-roster__btn.is-current', (e) => e.dataset.squad).catch(() => null);
        if (!cur) break;
        visited.add(cur);
        // 本拠地にいるので内政（農作）を 1 つ積む → 主役ボタンが「指示を終える」になる
        await fp.click('.chat-menu__btn[data-cmd="domestic"]');
        await fp.waitForSelector('.chat-opt[data-kind="farm"]', { timeout: 5000 });
        await fp.click('.chat-opt[data-kind="farm"]');
        await fp.waitForTimeout(250);
        if (k === 0) {
          const pop0 = await fp.evaluate(() => {
            const btn = document.querySelector('.chat-menu__btn[data-cmd="domestic"]');
            const c = document.querySelector('.chat-dom[data-kind="conscript"]');
            return { menu: btn ? btn.textContent : null, conscript: c ? { ok: c.dataset.ok, reason: c.dataset.reason, text: c.textContent } : null };
          });
          const farmed = await fp.evaluate(async (id) => (await import('/js/main.js')).getApp().state.squads[id].orders.some((o) => o.type === 'domestic' && o.kind === 'farm'), cur);
          check('chat: 人口 0 でも内政のメニューが開き、農作が積める（徴兵だけが「人口 0」で積めない）',
            farmed && !!pop0.conscript && pop0.conscript.ok === '0' && pop0.conscript.reason === 'pop' && /人口/.test(pop0.conscript.text), JSON.stringify({ farmed, ...pop0 }));
          await screenOk(fp, 'Chat 人口 0 の内政');
          await chatInfoChecks(fp, cur);
        }
        const act = await fp.$eval('.chat-dock .chat-primary', (e) => e.dataset.act).catch(() => null);
        if (k === 0) await shot(fp, 'f-finish');
        if (act === 'end') { reachedEnd = true; break; }
        check(`flow: ${k + 1} 人目に指示を積むと主役が「指示を終える」`, act === 'finish', String(act));
        await fp.click('.chat-dock .chat-primary');
        await fp.waitForTimeout(800);
        const next = await fp.$eval('.chat-roster__btn.is-current', (e) => e.dataset.squad).catch(() => null);
        if (next === cur || !next) {
          // 最後の 1 人は「指示を終える」で完了になり、主役が「ターン終了」に変わる
          const after = await fp.$eval('.chat-dock .chat-primary', (e) => e.dataset.act).catch(() => null);
          reachedEnd = after === 'end';
          break;
        }
      }
      check('flow: 「次のヒーローへ」で全員を順に回れた', visited.size === total, `${visited.size}/${total}`);
      check('flow: 全員の指示が終わると主役が「ターン終了」になる', reachedEnd);
      await shot(fp, 'f-alldone');
      // 戻る: トーク → 一覧 → ホーム
      await fp.click('.chat-head__back');
      await fp.waitForSelector('.chat--list', { timeout: 5000 });
      check('flow: トークの「戻る」で一覧へ', true);
      await fp.click('.chat--list .app-head__back');
      await fp.waitForTimeout(500);
      check('flow: 一覧の「戻る」でホームへ', (await currentApp(fp)) === 'home', String(await currentApp(fp)));
      if (reachedEnd) {
        await fp.evaluate(async () => (await import('/js/main.js')).go('chat'));
        await fp.waitForTimeout(400);
        // 全員済みなら、一覧の主役ボタンも「ターン終了」になっている
        const before = await fp.evaluate(async () => (await import('/js/main.js')).getApp().state.day);
        await fp.click('.chat-primary[data-act="end"]');
        await fp.waitForTimeout(300);
        if (await fp.$('.execbar__skip')) await fp.click('.execbar__skip');
        await fp.waitForSelector('.home, .soul-card, .swipe', { timeout: 20000 });
        const after = await fp.evaluate(async () => (await import('/js/main.js')).getApp().state.day);
        check('flow: 「ターン終了」で次の日へ進む', after === before + 1, `${before} -> ${after}`);
      }
      await flow.context.close();
    }

    // ---------- 古いセーブ（SPEC-113 §6.4） ----------
    await oldSaveChecks(browser, server.url);

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
