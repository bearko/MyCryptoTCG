// tools/sim.mjs — 無人シミュレーション（バランス確認用）
//
//   node tools/sim.mjs [seed=1] [runs=10]
//
// 全ランドを ai.plan で 28 日（または終了まで）回し、シードごとに
// ランドごとの砦ポイント・占領数・ヒーロー数・Legendary 砦までの最短距離を表で出す。
// 最後に全シードの集計（落ちた砦の数・Legendary 到達・1 日の処理時間）を出す。
// プレイヤーのランドも CPU として動かす（cpu フラグを立てる）。

import { loadDbFromFs } from '../js/data.js';
import { newGame } from '../js/state.js';
import { planCpu, execute, beginTurn } from '../js/engine/turn.js';
import { makeRng } from '../js/engine/rng.js';
import { distance } from '../js/engine/hex.js';
import { tileCount, score } from '../js/engine/season.js';

const seed0 = Number(process.argv[2] || 1);
const runs = Number(process.argv[3] || 10);
const quiet = process.argv.includes('--quiet');
const db = await loadDbFromFs();

const pad = (v, n) => String(v).padStart(n);
const padE = (v, n) => String(v).padEnd(n);

const total = { starves: 0, fromEnemy: 0, fallen: 0, legendary: 0, clears: 0, maxDayMs: 0, sumDayMs: 0, days: 0, moves: 0, battles: 0, ends: {} };

for (let k = 0; k < runs; k++) {
  const seed = seed0 + k;
  const state = newGame({ seed, playerLand: 'ocean', db });
  for (const l of Object.values(state.lands)) l.cpu = true;
  const rng = makeRng(seed * 7919 + 13);
  const legend = Object.values(state.forts).find((f) => f.rank === 'legendary');
  const { w, h } = state.map;
  const closest = {};
  let fallen = 0;
  let moves = 0;
  let battles = 0;
  let starves = 0;
  let fromEnemy = 0;
  let maxMs = 0;
  let sumMs = 0;
  let days = 0;
  while (!state.ended && state.day <= 28) {
    const t0 = performance.now();
    planCpu(state, db, rng);
    for (const e of execute(state, db, rng)) {
      if (e.t === 'fort_fallen') { fallen++; if (e.from === 'enemy') fromEnemy++; }
      else if (e.t === 'starve') starves++;
      else if (e.t === 'move') moves++;
      else if (e.t === 'battle') battles++;
    }
    for (const s of Object.values(state.squads)) {
      const d = distance(s.tile, legend.tile, w, h);
      if (closest[s.land] === undefined || d < closest[s.land]) closest[s.land] = d;
    }
    if (!state.ended) beginTurn(state, db);
    const ms = performance.now() - t0;
    maxMs = Math.max(maxMs, ms);
    sumMs += ms;
    days++;
  }
  const end = state.ended || { reason: 'none', winner: null };
  total.fallen += fallen;
  total.fromEnemy += fromEnemy;
  total.starves += starves;
  total.moves += moves;
  total.battles += battles;
  total.maxDayMs = Math.max(total.maxDayMs, maxMs);
  total.sumDayMs += sumMs;
  total.days += days;
  total.ends[end.reason] = (total.ends[end.reason] || 0) + 1;
  if (end.reason === 'clear') total.clears++;
  const minLegend = Math.min(...Object.values(closest));
  if (minLegend <= 3) total.legendary++;

  if (!quiet) {
    console.log(`\n== seed ${seed}  day ${state.day}  end ${end.reason}  winner ${end.winner}  fort_fallen ${fallen}（エネミーから ${fromEnemy}）  starve ${starves}  battles ${battles}  moves ${moves}  1日 平均 ${(sumMs / days).toFixed(1)}ms / 最大 ${maxMs.toFixed(1)}ms`);
    console.log(`${padE('land', 11)} ${pad('砦pt', 5)} ${pad('砦', 3)} ${pad('占領', 5)} ${pad('ヒーロー', 5)} ${pad('兵', 6)} ${pad('GUM', 5)} ${pad('food', 5)} ${pad('Leg距離', 6)} ${pad('score', 6)} alive`);
    for (const l of Object.values(state.lands)) {
      if (l.id === 'enemy') continue;
      const forts = Object.values(state.forts).filter((f) => f.owner === l.id).length;
      const sq = Object.values(state.squads).filter((s) => s.land === l.id);
      const troops = sq.reduce((a, s) => a + s.troops, 0);
      console.log(
        `${padE(l.id, 11)} ${pad(l.fortPoints, 5)} ${pad(forts, 3)} ${pad(tileCount(state, l.id), 5)} ${pad(sq.length, 5)} ${pad(troops, 6)} ${pad(l.res.gum, 5)} ${pad(l.res.food, 5)} ${pad(closest[l.id] ?? '-', 6)} ${pad(score(state, db, l.id).total, 6)} ${l.alive}`
      );
    }
    const enemyForts = Object.values(state.forts).filter((f) => f.owner === 'enemy').map((f) => f.rank[0]).join('');
    console.log(`エネミーに残った砦: ${enemyForts || '(なし)'}`);
  }
}

console.log(`\n== 集計（${runs} シード、seed ${seed0}..${seed0 + runs - 1}）`);
console.log(`落ちた砦 合計 ${total.fallen}（1 シード平均 ${(total.fallen / runs).toFixed(1)}）`);
console.log(`エネミーから落ちた砦 平均 ${(total.fromEnemy / runs).toFixed(1)} / 10、飢え（ランド×日）平均 ${(total.starves / runs).toFixed(0)}`);
console.log(`戦闘 平均 ${(total.battles / runs).toFixed(0)} / 移動 平均 ${(total.moves / runs).toFixed(0)}`);
console.log(`Legendary 砦の 3 ヘックス以内に誰かが来た: ${total.legendary}/${runs}、攻略: ${total.clears}/${runs}`);
console.log(`終わり方: ${JSON.stringify(total.ends)}`);
console.log(`1 日の処理時間 平均 ${(total.sumDayMs / total.days).toFixed(1)}ms / 最大 ${total.maxDayMs.toFixed(1)}ms`);
