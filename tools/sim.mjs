// tools/sim.mjs — 無人シミュレーション（バランス確認用）
//
//   node tools/sim.mjs [seed=1] [runs=10] [--quiet]
//   node tools/sim.mjs --player <none|farm1|farmMax|conscript2|all> [seed=1] [runs=10] [--quiet]
//   どちらも --json で、集計を JSON 1 行で出す（調整の道具から読むため）
//
// 全ランド CPU（既定）：全ランドを ai.plan で 28 日（または終了まで）回し、シードごとに
// ランドごとの砦ポイント・占領数・ヒーロー数・Legendary 砦までの最短距離を表で出す。
// 最後に全シードの集計（落ちた砦の数・Legendary 到達・1 日の処理時間）を出す。
// プレイヤーのランドも CPU として動かす（cpu フラグを立てる）。
//
// SPEC-113（士気と食料）の集計列：
//   飢え（ランド × 日）・逃走した兵の合計・逃走で兵が 0 になった部隊（1 シードで何部隊）・
//   配給「節約」/「増量」にしていたランド × 日・恩賞の回数・最後の日の士気（ランドごとの平均と最小）。
//   つまみ（k / d / m）は js/engine/tuning.js の値を表示する。
//
// --player（SPEC-113 §5 の方針）：プレイヤーのランド（ocean）だけを決め打ちの方針で動かし、残りは CPU。
//   方針ごと・シードごとに、1 日目の食料の差し引き（UI の「このあと」/ 上限で止めない流れ / 実際の増減）、
//   差し引きが初めてマイナスになった日、食料が尽きた日、28 日目の兵と士気、逃走の合計を表で出し、
//   最後に §5 の目標と並べた要約を出す。方針の中身は tools/sim-lib.mjs の先頭を見る。

import { loadDbFromFs } from '../js/data.js';
import { TUNING } from '../js/engine/tuning.js';
import { runCpu, runPlayer, POLICIES } from './sim-lib.mjs';

const args = process.argv.slice(2);
const quiet = args.includes('--quiet');
const json = args.includes('--json');
let player = null;
const pos = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--player') player = args[++i];
  else if (!args[i].startsWith('--')) pos.push(args[i]);
}
const seed0 = Number(pos[0] || 1);
const runs = Number(pos[1] || 10);
const db = await loadDbFromFs();

const pad = (v, n) => String(v ?? '-').padStart(n);
const padE = (v, n) => String(v ?? '-').padEnd(n);
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const log = (...a) => { if (!json) console.log(...a); };

log(`つまみ: k ${TUNING.k}（初期の兵 = 統率力 × k）/ d ${TUNING.d}（兵 ÷ d の食料）/ m ${TUNING.m}（農作 10 + 統治力 × m）`);

if (player) {
  const policies = player === 'all' ? POLICIES : [player];
  for (const p of policies) if (!POLICIES.includes(p)) throw new Error(`unknown policy: ${p}（${POLICIES.join(' / ')} / all）`);
  const summary = {};
  for (const policy of policies) {
    const rows = [];
    for (let k = 0; k < runs; k++) rows.push(runPlayer(db, seed0 + k, policy));
    if (!quiet) {
      log(`\n== 方針 ${policy}（プレイヤー ocean、ほかは CPU）`);
      log(`${padE('seed', 5)} ${pad('差引1', 6)} ${pad('流れ1', 6)} ${pad('実際1', 6)} ${pad('赤字日', 5)} ${pad('尽きた日', 7)} ${pad('飢え', 4)} ${pad('兵1', 5)} ${pad('兵28', 5)} ${pad('士気', 4)} ${pad('最小', 4)} ${pad('逃走', 5)} ${pad('部隊', 4)} alive`);
      for (const r of rows) {
        log(`${padE(r.seed, 5)} ${pad(r.net1, 6)} ${pad(r.flow1, 6)} ${pad(r.actual1, 6)} ${pad(r.firstDeficit, 5)} ${pad(r.foodOut, 7)} ${pad(r.starveDays, 4)} ${pad(r.troops1, 5)} ${pad(r.troops28, 5)} ${pad(r.moraleAvg, 4)} ${pad(r.moraleMin, 4)} ${pad(r.deserted, 5)} ${pad(r.squadsAlive, 4)} ${r.alive}`);
      }
    }
    const outs = rows.map((r) => r.foodOut);
    summary[policy] = {
      net1: { avg: avg(rows.map((r) => r.net1)), min: Math.min(...rows.map((r) => r.net1)), max: Math.max(...rows.map((r) => r.net1)) },
      flow1: { avg: avg(rows.map((r) => r.flow1)), min: Math.min(...rows.map((r) => r.flow1)), max: Math.max(...rows.map((r) => r.flow1)) },
      firstDeficit: rows.map((r) => r.firstDeficit),
      foodOut: outs,
      foodOutMin: outs.some((x) => x !== null) ? Math.min(...outs.filter((x) => x !== null)) : null,
      neverOut: outs.filter((x) => x === null).length,
      troops28: avg(rows.map((r) => r.troops28)),
      morale28: avg(rows.map((r) => r.moraleAvg ?? 0)),
      deserted: avg(rows.map((r) => r.deserted)),
      wiped: rows.filter((r) => r.squadsAlive === 0 || !r.alive).length,
    };
  }
  if (json) {
    console.log(JSON.stringify({ tuning: TUNING, seed0, runs, player: summary }));
  } else {
    log(`\n== 要約（${runs} シード、seed ${seed0}..${seed0 + runs - 1}）。差引 = UI の「このあと」、流れ = 上限で止めない産出 + 農作 − 消費`);
    log(`${padE('方針', 11)} ${pad('差引1 平均', 10)} ${pad('最小', 5)} ${pad('最大', 5)} ${pad('流れ1 平均', 10)} ${pad('尽きた日 最早', 12)} ${pad('尽きない', 6)} ${pad('兵28', 6)} ${pad('士気28', 6)} ${pad('逃走', 6)} 全滅  赤字になった日 / 尽きた日`);
    for (const [p, s] of Object.entries(summary)) {
      log(`${padE(p, 11)} ${pad(s.net1.avg.toFixed(1), 10)} ${pad(s.net1.min, 5)} ${pad(s.net1.max, 5)} ${pad(s.flow1.avg.toFixed(1), 10)} ${pad(s.foodOutMin, 12)} ${pad(s.neverOut, 6)} ${pad(s.troops28.toFixed(0), 6)} ${pad(s.morale28.toFixed(0), 6)} ${pad(s.deserted.toFixed(0), 6)} ${pad(s.wiped, 4)}  ${s.firstDeficit.map((x) => x ?? '-').join(',')} / ${s.foodOut.map((x) => x ?? '-').join(',')}`);
    }
    log('目標（SPEC-113 §5）: none 食料 6 日以上（尽きた日 7 以上）・全滅なし / farm1 差引1 −10〜+5 / farmMax 差引1 +10 以上 / conscript2 4〜8 日目に赤字');
  }
} else {
  const total = {
    starves: 0, fromEnemy: 0, fallen: 0, legendary: 0, clears: 0, maxDayMs: 0, sumDayMs: 0, days: 0, moves: 0, battles: 0, ends: {},
    deserted: 0, zeroed: 0, saveDays: 0, feastDays: 0, rewards: 0, moraleSum: 0, moraleN: 0, shaken: 0,
  };
  for (let k = 0; k < runs; k++) {
    const r = runCpu(db, seed0 + k);
    total.fallen += r.fallen;
    total.fromEnemy += r.fromEnemy;
    total.starves += r.starves;
    total.moves += r.moves;
    total.battles += r.battles;
    total.maxDayMs = Math.max(total.maxDayMs, r.maxMs);
    total.sumDayMs += r.sumMs;
    total.days += r.days;
    total.ends[r.end.reason] = (total.ends[r.end.reason] || 0) + 1;
    if (r.clear) total.clears++;
    total.deserted += r.deserted;
    total.zeroed += r.zeroed;
    total.saveDays += r.saveDays;
    total.feastDays += r.feastDays;
    total.rewards += r.rewards;
    total.moraleSum += r.morale.sum;
    total.moraleN += r.morale.n;
    total.shaken += r.morale.shaken;
    if (r.legendary) total.legendary++;

    if (!quiet) {
      log(`\n== seed ${r.seed}  day ${r.day}  end ${r.end.reason}  winner ${r.end.winner}  fort_fallen ${r.fallen}（エネミーから ${r.fromEnemy}）  starve ${r.starves}  battles ${r.battles}  moves ${r.moves}  1日 平均 ${(r.sumMs / r.days).toFixed(1)}ms / 最大 ${r.maxMs.toFixed(1)}ms`);
      log(`   逃走 ${r.deserted} 人（兵 0 になった部隊 ${r.zeroed}）  配給 節約 ${r.saveDays} / 増量 ${r.feastDays}（ランド×日）  恩賞 ${r.rewards} 回`);
      log(`${padE('land', 11)} ${pad('砦pt', 5)} ${pad('砦', 3)} ${pad('占領', 5)} ${pad('ヒーロー', 5)} ${pad('兵', 6)} ${pad('GUM', 5)} ${pad('food', 5)} ${pad('pop', 4)} ${pad('士気', 4)} ${pad('最小', 4)} ${pad('配給', 6)} ${pad('飢え', 4)} ${pad('逃走', 4)} ${pad('Leg距離', 6)} ${pad('score', 6)} alive`);
      for (const l of r.lands) {
        log(`${padE(l.id, 11)} ${pad(l.fortPoints, 5)} ${pad(l.forts, 3)} ${pad(l.tiles, 5)} ${pad(l.heroes, 5)} ${pad(l.troops, 6)} ${pad(l.gum, 5)} ${pad(l.food, 5)} ${pad(l.pop, 4)} ${pad(l.moraleAvg, 4)} ${pad(l.moraleMin, 4)} ${pad(l.ration, 6)} ${pad(l.starves, 4)} ${pad(l.deserted, 4)} ${pad(l.legend, 6)} ${pad(l.score, 6)} ${l.alive}`);
      }
      log(`エネミーに残った砦: ${r.enemyForts || '(なし)'}`);
    }
  }
  if (json) {
    console.log(JSON.stringify({
      tuning: TUNING, seed0, runs,
      cpu: {
        fallen: total.fallen / runs, fromEnemy: total.fromEnemy / runs, starves: total.starves / runs, zeroed: total.zeroed / runs,
        deserted: total.deserted / runs, legendary: total.legendary, clears: total.clears, saveDays: total.saveDays / runs,
        feastDays: total.feastDays / runs, rewards: total.rewards / runs, morale: total.moraleN ? total.moraleSum / total.moraleN : null,
        battles: total.battles / runs, maxDayMs: total.maxDayMs,
      },
    }));
  } else {
    log(`\n== 集計（${runs} シード、seed ${seed0}..${seed0 + runs - 1}）`);
    log(`落ちた砦 合計 ${total.fallen}（1 シード平均 ${(total.fallen / runs).toFixed(1)}）`);
    log(`エネミーから落ちた砦 平均 ${(total.fromEnemy / runs).toFixed(1)} / 10、飢え（ランド×日）平均 ${(total.starves / runs).toFixed(0)}`);
    log(`戦闘 平均 ${(total.battles / runs).toFixed(0)} / 移動 平均 ${(total.moves / runs).toFixed(0)}`);
    log(`士気（最後の日・敗走中を除く）平均 ${total.moraleN ? (total.moraleSum / total.moraleN).toFixed(1) : '-'}、20 未満 ${total.shaken} 部隊（全シード）`);
    log(`逃走した兵 平均 ${(total.deserted / runs).toFixed(1)} 人、逃走で兵が 0 になった部隊 平均 ${(total.zeroed / runs).toFixed(1)}`);
    log(`配給 節約 平均 ${(total.saveDays / runs).toFixed(1)} / 増量 平均 ${(total.feastDays / runs).toFixed(1)}（ランド×日）、恩賞 平均 ${(total.rewards / runs).toFixed(1)} 回`);
    log(`Legendary 砦の 3 ヘックス以内に誰かが来た: ${total.legendary}/${runs}、攻略: ${total.clears}/${runs}`);
    log(`終わり方: ${JSON.stringify(total.ends)}`);
    log(`1 日の処理時間 平均 ${(total.sumDayMs / total.days).toFixed(1)}ms / 最大 ${total.maxDayMs.toFixed(1)}ms`);
  }
}
