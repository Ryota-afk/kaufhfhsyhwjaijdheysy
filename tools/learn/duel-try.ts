// AIどうしの1試合（src/learn/duel.ts）を数試合打って、時間とエラーを見る。
// 使い方：npx tsx tools/learn/duel-try.ts [試合数=2] [探索の回数=200] [種=1]
import { readFileSync } from 'node:fs';
import { loadShowdown, loadShowdownCopy, FORMAT } from '../showdown/load.ts';
import { applySpeedLayer } from '../../src/engine/fast.ts';
import { makeCloner } from '../../src/engine/clone.ts';
import { makeRunner } from '../../src/engine/runner.ts';
import { makeAnalyzer } from '../../src/battle/analyze.ts';
import { playDuel } from '../../src/learn/duel.ts';
import { DEFAULT_SETTINGS } from '../../src/learn/decide.ts';

const [N, ITERS, SEED] = [2, 200, 1].map((d, i) => Number(process.argv[2 + i] ?? d));
// 記録を作る写し（本当の対戦・記録係）と、速さの層を当てた写し（探索）
const PS = loadShowdown(), FAST = loadShowdownCopy(); applySpeedLayer(FAST, FAST.Battle, FORMAT);
const dex = PS.Dex.forFormat(FORMAT);
const env = { dex, Runner: makeRunner(PS, FORMAT), FastRunner: makeRunner(FAST, FORMAT), clone: makeCloner(FAST.Dex.forFormat(FORMAT), FAST.Pokemon), Analyzer: makeAnalyzer(PS, FORMAT, JSON.parse(readFileSync('data/priors/sets.json', 'utf8')), JSON.parse(readFileSync('data/seed/teams_m7.json', 'utf8')), JSON.parse(readFileSync('data/seed/selections_m7.json', 'utf8'))) };
const teams = JSON.parse(readFileSync('data/seed/teams_m7.json', 'utf8'));
let st = SEED * 31 + 1; const rand = () => { st = (st * 16807) % 2147483647; return st / 2147483647; };
for (let g = 0; g < N; g++) {
  const T: [any, any] = [teams[Math.floor(rand() * 50)], teams[Math.floor(rand() * 50)]];
  const pick = () => [0, 1, 2, 3, 4, 5].sort(() => rand() - 0.5).slice(0, 3);
  const r = playDuel(env, { teams: T, idx: [pick(), pick()], settings: [DEFAULT_SETTINGS, DEFAULT_SETTINGS], iters: ITERS, seed: g + 1 });
  if (process.env.COUNT_SIDES) { const c = [0, 0]; for (const e of r.errors) { if (e.startsWith("側1")) c[0]++; else if (e.startsWith("側2")) c[1]++; } console.log(`側ごとのエラー ${c.join(" / ")}`); }
  console.log(`試合${g}：勝ち ${r.winner === null ? '決着なし' : `p${r.winner + 1}`}、${r.turns}ターン、${(r.ms / 1000).toFixed(1)}秒、エラー ${r.errors.length} ${JSON.stringify(r.errors.slice(0, 3))}`);
}
