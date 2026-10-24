// turn 班のテスト：turn.js / state.js / ai.js / data.js を本物の data で通す。node --test tests/turn.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDbFromFs } from '../js/data.js';
import { newGame, serialize, deserialize, save, load } from '../js/state.js';
import { beginTurn, planCpu, execute, finishDay, revealFog, noticesFrom, targetAt } from '../js/engine/turn.js';
import { plan } from '../js/engine/ai.js';
import { makeRng } from '../js/engine/rng.js';
import { neighbors } from '../js/engine/hex.js';
import { findPath } from '../js/engine/pathfind.js';
import { queue } from '../js/engine/orders.js';
import { startTroops } from '../js/engine/tuning.js';

const db = await loadDbFromFs();

function hasSetOrMap(v, seen = new Set()) {
  if (v instanceof Set || v instanceof Map) return true;
  if (v && typeof v === 'object') {
    if (seen.has(v)) return false;
    seen.add(v);
    return Object.values(v).some((x) => hasSetOrMap(x, seen));
  }
  return false;
}

test('loadDbFromFs は契約の形の db を返す', () => {
  assert.equal(db.lands.length, 9);
  assert.ok(db.terrain.grass && db.facilities.farm);
  assert.ok(db.heroList.length > 0);
  assert.equal(db.heroes[db.heroList[0].id], db.heroList[0]);
  assert.ok(Array.isArray(db.enemies) && db.enemies.length > 0);
  assert.ok(db.extensions.ext_boots);
  assert.ok(db.messages.messages['report.win']);
});

test('newGame: 9 ランド + enemy、3 体ずつ、初期資源、砦 10、霧が開いている、指示フェーズ', () => {
  const st = newGame({ seed: 1, playerLand: 'ocean', db });
  assert.equal(Object.keys(st.lands).length, 10);
  assert.equal(st.phase, 'orders');
  assert.equal(st.day, 1);
  assert.equal(Object.keys(st.forts).length, 10);
  const heroIds = new Set();
  for (const l of db.lands) {
    const land = st.lands[l.id];
    assert.deepEqual(land.res, { pop: 100, food: 150, gum: 120, mat: 60 });
    assert.equal(land.cpu, l.id !== 'ocean');
    assert.ok(land.explored.length > 0);
    assert.ok(land.explored.includes(land.home));
    const sq = Object.values(st.squads).filter((s) => s.land === l.id);
    assert.equal(sq.length, 3);
    for (const s of sq) {
      assert.match(s.id, /^s\d+$/);
      assert.equal(s.tile, land.home);
      assert.equal(s.troops, startTroops(db.heroes[s.heroId].params.lead)); // 統率力 × k（SPEC-113 §5）
      assert.ok(s.ap > 0);
      heroIds.add(s.heroId);
    }
  }
  assert.equal(heroIds.size, 27, 'ヒーローはランドどうしで重ならない');
  assert.ok(!hasSetOrMap(st));
});

test('newGame は seed が同じなら同じ', () => {
  const a = newGame({ seed: 5, playerLand: 'ruby', db });
  const b = newGame({ seed: 5, playerLand: 'ruby', db });
  assert.equal(serialize(a), serialize(b));
});

test('serialize / deserialize で往復できる。save / load は localStorage が無ければ何もしない', () => {
  const st = newGame({ seed: 2, playerLand: 'lime', db });
  const back = deserialize(serialize(st));
  assert.deepEqual(back, st);
  assert.equal(save(st), false);
  assert.equal(load(), null);
  assert.throws(() => deserialize('{"version":999}'));
});

test('ai.plan は orders.queue で指示を積み、AP を超えない', () => {
  const st = newGame({ seed: 3, playerLand: 'ocean', db });
  const rng = makeRng(1);
  plan(st, db, rng, 'ruby');
  const sq = Object.values(st.squads).filter((s) => s.land === 'ruby');
  assert.ok(sq.some((s) => s.orders.length > 0), 'だれかは指示を積む');
  for (const s of sq) {
    assert.equal(s.policy, 'fight');
    assert.ok(s.ap >= 0);
    for (const o of s.orders) assert.equal(typeof o.ap, 'number');
  }
});

test('execute: 移動は 1 タイルずつ。プレイヤーの移動が届く', () => {
  const st = newGame({ seed: 4, playerLand: 'ocean', db });
  const me = Object.values(st.squads).find((s) => s.land === 'ocean');
  const hero = db.heroes[me.heroId];
  // 2〜3 歩先の、空いている陸を探す
  const { w, h } = st.map;
  let goal = null;
  for (const a of neighbors(me.tile, w, h)) {
    for (const b of neighbors(a, w, h)) {
      const p = findPath(st, db, me, hero, b);
      if (p && p.path.length === 2 && p.cost <= me.ap) goal = { b, p };
    }
  }
  assert.ok(goal, '2 歩先に行ける場所がある');
  assert.ok(queue(st, db, me.id, { type: 'move', path: goal.p.path }).ok);
  const rng = makeRng(9);
  const events = [...execute(st, db, rng)];
  const mv = events.filter((e) => e.t === 'move' && e.squad === me.id);
  assert.equal(mv.length, 2);
  assert.equal(mv[0].to, goal.p.path[0]);
  assert.equal(st.squads[me.id].tile, goal.b);
  assert.equal(st.day, 2);
  assert.ok(events.some((e) => e.t === 'yield'));
  assert.equal(st.log.length, events.length);
});

test('execute: 本拠地にいない内政は blocked(home)、AP 不足は blocked(ap)', () => {
  const st = newGame({ seed: 6, playerLand: 'ocean', db });
  const me = Object.values(st.squads).find((s) => s.land === 'ocean');
  // 実行時に状況が変わった、として本拠地の外へ動かす
  me.orders = [{ type: 'domestic', kind: 'farm', ap: 2 }];
  const away = neighbors(me.tile, st.map.w, st.map.h)[0];
  me.tile = away;
  const events = [...execute(st, db, makeRng(1))];
  assert.ok(events.some((e) => e.t === 'blocked' && e.squad === me.id && e.reason === 'home'));
});

test('beginTurn: 敗走した部隊は AP 0 で、兵を 統率力 × k まで人口から集め直す（SPEC-113 §2）。奇襲は AP 半分', () => {
  const st = newGame({ seed: 7, playerLand: 'ocean', db });
  const [a, b] = Object.values(st.squads).filter((s) => s.land === 'ocean');
  const land = st.lands.ocean;
  const full = a.ap;
  a.status = 'routed';
  a.troops = 0;
  a.tile = b.tile;
  b.ambushed = true;
  const fullB = b.ap;
  land.res.pop = 500; // 上限を超えて足りる人口
  const goal = startTroops(db.heroes[a.heroId].params.lead);
  const evs = beginTurn(st, db);
  assert.equal(a.ap, 0);
  assert.equal(a.status, 'ok');
  assert.equal(a.tile, land.home);
  assert.equal(a.troops, goal, '統率力 × k（lead × 3 ではない）');
  assert.equal(land.res.pop, 500 - goal, '集め直した兵の分だけ人口を使う');
  assert.deepEqual(evs, [{ t: 'regroup', squad: a.id, land: 'ocean', amount: goal }]);
  assert.equal(b.ap, Math.ceil(fullB / 2));
  assert.equal(b.ambushed, false);
  assert.deepEqual(beginTurn(st, db), [], '敗走していなければ何も起きない');
  assert.equal(a.ap, full);
});

test('beginTurn: 敗走明けの兵は人口が足りる分だけ。人口 0 なら兵 0 のまま復帰し、兵も人口も増えない', () => {
  const st = newGame({ seed: 7, playerLand: 'ocean', db });
  const [a, b] = Object.values(st.squads).filter((s) => s.land === 'ocean');
  const land = st.lands.ocean;
  const goal = startTroops(db.heroes[a.heroId].params.lead);
  assert.ok(goal > 7);
  a.status = 'routed';
  a.troops = 0;
  land.res.pop = 7;
  let evs = beginTurn(st, db);
  assert.equal(a.troops, 7);
  assert.equal(land.res.pop, 0);
  assert.equal(evs[0].amount, 7);
  // 人口 0：兵の合計も人口も変わらない（観測：人口 0 のまま 22 → 189 に戻っていた）
  b.status = 'routed';
  b.troops = 0;
  const total = Object.values(st.squads).filter((s) => s.land === 'ocean').reduce((x, s) => x + s.troops, 0);
  evs = beginTurn(st, db);
  assert.equal(b.status, 'ok');
  assert.equal(b.ap, 0);
  assert.equal(b.troops, 0);
  assert.equal(land.res.pop, 0);
  assert.equal(Object.values(st.squads).filter((s) => s.land === 'ocean').reduce((x, s) => x + s.troops, 0), total);
  assert.deepEqual(evs, [{ t: 'regroup', squad: b.id, land: 'ocean', amount: 0 }]);
  // 通知：集め直した / 人口が無くて集められない
  const ns = noticesFrom(st, db, [{ t: 'regroup', squad: a.id, land: 'ocean', amount: 7 }, ...evs]);
  assert.equal(ns.length, 2);
  assert.ok(ns[0].text.includes('+7') && ns[0].text.includes('人口 −7'));
  assert.ok(ns[1].text.includes('人口 0') && ns[1].text.includes('兵 0 のまま'));
});

test('finishDay: 日曜に集計、28 日目のあとに season で終わる', () => {
  const st = newGame({ seed: 8, playerLand: 'ocean', db });
  st.day = 7;
  let ev = finishDay(st, db);
  assert.ok(ev.some((e) => e.t === 'week_end' && e.week === 1));
  assert.equal(st.day, 8);
  st.day = 28;
  ev = finishDay(st, db);
  assert.ok(ev.some((e) => e.t === 'week_end' && e.week === 4));
  assert.ok(ev.some((e) => e.t === 'season_end'));
  assert.equal(st.ended.reason, 'season');
  assert.equal(st.phase, 'ended');
  assert.equal(st.day, 28);
});

test('finishDay: Legendary をランドが持てば clear で終わる', () => {
  const st = newGame({ seed: 8, playerLand: 'ocean', db });
  const leg = Object.values(st.forts).find((f) => f.rank === 'legendary');
  leg.owner = 'ruby';
  finishDay(st, db);
  assert.deepEqual(st.ended, { reason: 'clear', winner: 'ruby' });
});

test('targetAt: 本拠地 → 砦 → 部隊', () => {
  const st = newGame({ seed: 9, playerLand: 'ocean', db });
  const rubyHome = st.lands.ruby.home;
  assert.deepEqual(targetAt(st, 'ocean', rubyHome), { home: 'ruby' });
  assert.equal(targetAt(st, 'ruby', rubyHome), null);
  const f = Object.values(st.forts)[0];
  assert.equal(targetAt(st, 'ocean', f.tile), f);
});

test('revealFog は視界を広げ、重複を持たない', () => {
  const st = newGame({ seed: 10, playerLand: 'ocean', db });
  const land = st.lands.ocean;
  const before = land.explored.length;
  const s = Object.values(st.squads).find((x) => x.land === 'ocean');
  const { w, h } = st.map;
  let t = s.tile;
  for (let k = 0; k < 6; k++) t = neighbors(t, w, h).slice(-1)[0];
  s.tile = t;
  revealFog(st, db, 'ocean');
  assert.ok(land.explored.length >= before);
  assert.equal(new Set(land.explored).size, land.explored.length);
  assert.ok(land.explored.includes(t));
});

test('28 日回す（seed 1, ocean）：落ちない・day が進む・ended が付く・資源が負にならない・JSON 往復できる', () => {
  let st = newGame({ seed: 1, playerLand: 'ocean', db });
  const rng = makeRng(42);
  let lastDay = st.day;
  let notices = 0;
  for (let k = 0; k < 40 && !st.ended; k++) {
    planCpu(st, db, rng);
    const events = [...execute(st, db, rng)];
    assert.ok(events.length > 0);
    const ns = noticesFrom(st, db, events);
    for (const n of ns) {
      assert.equal(typeof n.text, 'string');
      assert.ok(!/\{\w+\}/.test(n.text), `差し込みの抜け: ${n.text}`);
    }
    notices += ns.length;
    st.notices.push(...ns);
    // プレイヤーの選択待ちは、先頭を選んで片づける（UI の代わり）
    st.pending = [];
    if (!st.ended) {
      assert.ok(st.day === lastDay + 1, `day が進む: ${lastDay} → ${st.day}`);
      lastDay = st.day;
      beginTurn(st, db);
    }
    for (const l of Object.values(st.lands)) {
      for (const key of ['pop', 'food', 'gum', 'mat']) assert.ok(l.res[key] >= 0, `${l.id}.${key} = ${l.res[key]}`);
    }
    for (const s of Object.values(st.squads)) assert.ok(s.troops >= 0);
    assert.ok(!hasSetOrMap(st));
    st = deserialize(serialize(st));
  }
  assert.ok(st.ended, 'ended が付く');
  assert.ok(['clear', 'season', 'home_fallen'].includes(st.ended.reason));
  assert.ok(st.day <= 28);
  assert.ok(notices > 0);
});
