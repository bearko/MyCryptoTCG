// turn 班のテスト：season.js。node --test tests/season.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../js/engine/season.js';

function mini() {
  const tiles = Array.from({ length: 6 }, () => ({ owner: null, facility: null }));
  const land = (id) => ({ id, alive: true, fortPoints: 0, points: { week1: 0, week2: 0, week3: 0, week4: 0 } });
  return {
    day: 7,
    playerLand: 'ocean',
    map: { w: 3, h: 2, tiles },
    lands: { ocean: land('ocean'), ruby: land('ruby'), enemy: land('enemy') },
    squads: {},
    forts: {
      f1: { id: 'f1', rank: 'rare', owner: 'ocean', tile: 0 },
      f2: { id: 'f2', rank: 'epic', owner: 'ruby', tile: 1 },
      f3: { id: 'f3', rank: 'legendary', owner: 'enemy', tile: 2 },
    },
    ended: null,
  };
}

test('週・季節・曜日', () => {
  assert.deepEqual([1, 7, 8, 14, 15, 21, 22, 28].map(S.weekOf), [1, 1, 2, 2, 3, 3, 4, 4]);
  assert.equal(S.seasonOf(1), 'spring');
  assert.equal(S.seasonOf(8), 'summer');
  assert.equal(S.seasonOf(15), 'autumn');
  assert.equal(S.seasonOf(28), 'winter');
  assert.equal(S.dayOfWeek(1), 0);
  assert.equal(S.dayOfWeek(7), 6);
  assert.equal(S.dayOfWeek(14), 6);
  assert.equal(S.dayOfWeek(15), 0);
});

test('砦ポイントとバッテリー', () => {
  assert.equal(S.fortPoints('rare'), 1);
  assert.equal(S.fortPoints('epic'), 3);
  assert.equal(S.fortPoints('legendary'), 10);
  assert.equal(S.battery(1), 100);
  assert.equal(S.battery(15), 50);
  assert.equal(S.battery(28), 4);
  assert.equal(S.battery(29), 0);
});

test('tallyWeek は砦の持ち主に入れ、エネミーには入れない', () => {
  const st = mini();
  const ev = S.tallyWeek(st);
  assert.equal(ev.t, 'week_end');
  assert.equal(ev.week, 1);
  assert.deepEqual(ev.points, { ocean: 1, ruby: 3 });
  assert.equal(st.lands.ocean.fortPoints, 1);
  assert.equal(st.lands.ruby.points.week1, 3);
  assert.equal(st.lands.enemy.fortPoints, 0);
});

test('checkEnd: 何もなければ null、Legendary を持てば clear', () => {
  const st = mini();
  assert.equal(S.checkEnd(st, {}), null);
  st.forts.f3.owner = 'ruby';
  assert.deepEqual(S.checkEnd(st, {}), { reason: 'clear', winner: 'ruby' });
});

test('checkEnd: プレイヤーの本拠地が落ちたら home_fallen', () => {
  const st = mini();
  st.lands.ocean.alive = false;
  assert.equal(S.checkEnd(st, {}).reason, 'home_fallen');
});

test('checkEnd: 28 日目の後は season。最多砦ポイント、同点は占領数', () => {
  const st = mini();
  st.day = 29;
  st.lands.ocean.fortPoints = 5;
  st.lands.ruby.fortPoints = 5;
  st.map.tiles[3].owner = 'ruby';
  assert.deepEqual(S.checkEnd(st, {}), { reason: 'season', winner: 'ruby' });
  st.map.tiles[4].owner = 'ocean';
  st.map.tiles[5].owner = 'ocean';
  assert.equal(S.checkEnd(st, {}).winner, 'ocean');
});

test('checkEnd: state.ended が付いていればそれを返す（ギブアップ）', () => {
  const st = mini();
  st.ended = { reason: 'giveup', winner: null };
  assert.equal(S.checkEnd(st, {}).reason, 'giveup');
});

test('score は spec §11 の式', () => {
  const st = mini();
  st.lands.ocean.fortPoints = 4;
  st.map.tiles[0].owner = 'ocean';
  st.map.tiles[3].owner = 'ocean';
  st.map.tiles[3].facility = { kind: 'farm', rank: 2 };
  st.squads = { s1: { land: 'ocean' }, s2: { land: 'ocean' }, s3: { land: 'ruby' } };
  const sc = S.score(st, {}, 'ocean');
  assert.equal(sc.total, 400 + 10 + 100 + 40);
  st.ended = { reason: 'clear', winner: 'ocean' };
  st.day = 20;
  const sc2 = S.score(st, {}, 'ocean');
  assert.equal(sc2.breakdown.clear, 2000);
  assert.equal(sc2.breakdown.daysLeft, 8 * 30);
});
