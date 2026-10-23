import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { say, uiText } from '../js/engine/lines.js';

const load = (p) => JSON.parse(readFileSync(new URL('../' + p, import.meta.url), 'utf8'));
const messages = load('data/messages.json');
const terrain = load('data/terrain.json');
const facilities = load('data/facilities.json');
const db = { messages };

const IDS = [
  'greet.morning', 'order.move.ack', 'order.claim.ack', 'order.build.ack', 'order.attack.ack',
  'order.domestic.ack', 'order.rest.ack', 'order.policy.ack', 'order.reject.ap', 'order.reject.home',
  'order.reject.range', 'order.reject.build', 'report.arrived', 'report.blocked', 'report.win',
  'report.lose', 'report.routed', 'report.ambush', 'report.ambushed_them', 'report.fort',
  'report.ask', 'report.build_done', 'report.domestic', 'join', 'idle',
];
const TONES = ['bushi', 'noble', 'scholar', 'rogue', 'plain'];
const ALLOWED = new Set(['name', 'dest', 'days', 'ap', 'troops', 'target', 'kind', 'n', 'day']);
const EMOJI = /\p{Extended_Pictographic}/u;

test('口調は 5 つ', () => {
  assert.deepEqual(messages.tones, TONES);
});

test('25 ID × 5 口調 = 125 文が埋まっている（40 字以内・絵文字なし・既知の差し込みだけ）', () => {
  assert.deepEqual(Object.keys(messages.messages).sort(), [...IDS].sort());
  let count = 0;
  for (const id of IDS) {
    for (const tone of TONES) {
      const s = messages.messages[id][tone];
      assert.equal(typeof s, 'string', `${id}.${tone}`);
      assert.ok(s.length > 0, `${id}.${tone} empty`);
      assert.ok([...s].length <= 40, `${id}.${tone} too long: ${s}`);
      assert.ok(!EMOJI.test(s), `${id}.${tone} emoji`);
      for (const m of s.matchAll(/\{(\w+)\}/g)) assert.ok(ALLOWED.has(m[1]), `${id}.${tone} {${m[1]}}`);
      count++;
    }
    // 口調ごとに文が違う
    assert.equal(new Set(TONES.map((t) => messages.messages[id][t])).size, 5, `${id} tones not distinct`);
  }
  assert.equal(count, 125);
});

test('使うと決めた差し込みがその ID の全口調に入っている', () => {
  const need = {
    'order.move.ack': ['dest', 'days'], 'order.build.ack': ['kind', 'days'], 'order.attack.ack': ['target'],
    'order.domestic.ack': ['kind'], 'order.policy.ack': ['kind'], 'order.reject.ap': ['ap'],
    'order.reject.build': ['kind'], 'report.arrived': ['dest'], 'report.win': ['target'],
    'report.lose': ['target'], 'report.ambushed_them': ['target'], 'report.fort': ['target'],
    'report.build_done': ['kind'], 'report.domestic': ['kind', 'n'], join: ['name'], idle: ['ap'],
  };
  for (const [id, keys] of Object.entries(need)) {
    for (const tone of TONES) for (const k of keys) {
      assert.ok(messages.messages[id][tone].includes(`{${k}}`), `${id}.${tone} lacks {${k}}`);
    }
  }
});

test('say: 口調ごとの文と差し込み', () => {
  const hero = { name: 'テスト', tone: 'bushi' };
  assert.equal(say(db, hero, 'order.move.ack', { dest: '草原', days: 2 }), '草原へ向かう。2日で着く見込みだ。');
  const r = say(db, { name: 'A', tone: 'rogue' }, 'report.domestic', { kind: '徴兵', n: 12 });
  assert.ok(r.includes('徴兵') && r.includes('12') && !r.includes('{'));
});

test('say: {name} は hero.name を既定に、vars が優先', () => {
  assert.ok(say(db, { name: '甲', tone: 'plain' }, 'join').includes('甲'));
  assert.ok(say(db, { name: '甲', tone: 'plain' }, 'join', { name: '乙' }).includes('乙'));
  assert.ok(say(db, { name: '甲', tone: 'noble' }, 'greet.morning', { day: 3 }).includes('3日目'));
});

test('say: tone が無い・未知なら plain', () => {
  const plain = messages.messages['order.rest.ack'].plain;
  assert.equal(say(db, { name: 'x' }, 'order.rest.ack'), plain);
  assert.equal(say(db, { name: 'x', tone: 'pirate' }, 'order.rest.ack'), plain);
  assert.equal(say(db, null, 'order.rest.ack'), plain);
});

test('say: 未知の ID はそのまま返す', () => {
  assert.equal(say(db, { name: 'x', tone: 'bushi' }, 'no.such.id', {}), 'no.such.id');
  assert.equal(say({}, null, 'order.rest.ack'), 'order.rest.ack');
  assert.equal(say(db, null, 'toString'), 'toString');
});

test('say: vars に無い差し込みは残す', () => {
  assert.ok(say(db, { name: 'x', tone: 'plain' }, 'order.move.ack', {}).includes('{dest}'));
});

test('uiText: 引けるキーと、無いキー', () => {
  assert.equal(uiText(db, 'res.gum'), 'GUM');
  assert.equal(uiText(db, 'dow.0'), '月');
  assert.equal(uiText(db, 'dow.6'), '日');
  assert.equal(uiText(db, 'no.such.key'), 'no.such.key');
  assert.equal(uiText({}, 'res.gum'), 'res.gum');
});

test('ui の網羅', () => {
  const ui = messages.ui;
  const keys = [
    ...terrain.map((t) => `terrain.${t.id}`),
    ...facilities.map((f) => `facility.${f.id}`),
    ...['front', 'mid', 'back'].map((m) => `cls.${m}`),
    ...['vanguard', 'striker', 'guard', 'commander', 'scout', 'gunner', 'support', 'sniper', 'caster', 'healer'].map((s) => `sub.${s}`),
    ...['ignore', 'fight', 'ask'].map((p) => `policy.${p}`),
    ...['spring', 'summer', 'autumn', 'winter'].map((s) => `season.${s}`),
    ...[0, 1, 2, 3, 4, 5, 6].map((d) => `dow.${d}`),
    ...['pop', 'food', 'gum', 'mat'].map((r) => `res.${r}`),
    ...['move', 'claim', 'build', 'attack', 'domestic', 'rest', 'policy', 'clear'].map((c) => `cmd.${c}`),
    ...['conscript', 'farm', 'trade', 'craft'].map((k) => `domestic.${k}`),
    ...['rare', 'epic', 'legendary'].map((r) => `fort.${r}`),
    ...['clear', 'season', 'home_fallen', 'giveup'].map((e) => `end.${e}`),
    ...['home', 'map', 'chat', 'calendar', 'drive', 'photo', 'land', 'result'].map((a) => `app.${a}`),
    'home.endTurn', 'map.endTurn', 'map.go', 'execute.skip', 'result.again',
  ];
  for (const k of keys) {
    assert.equal(typeof ui[k], 'string', `missing ui ${k}`);
    assert.ok(ui[k].length > 0, `empty ui ${k}`);
  }
  for (const [k, v] of Object.entries(ui)) {
    assert.ok(!EMOJI.test(v), `emoji in ${k}`);
    assert.ok(!/ゴールド|金銭|ユニット/.test(v), `forbidden term in ${k}`);
  }
});
