// 対戦記録から数えた割合の確かめ：試合の模擬で作った記録（LOGDIR=… npx tsx tools/battle/sim-check.ts）を数え、
// 相手の本当の型・本当の選出の最初の確率が、記録を数える前より上がるかを見る。
// 使い方：npx tsx tools/learn/learn-check.ts <記録のフォルダ（logs と truth がある）>
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { loadShowdown, FORMAT } from '../showdown/load.ts';
import { expandPrior } from '../../src/infer/sets.ts';
import { mergePriors, seedKey } from '../../src/learn/merge.ts';
import { BenchModel } from '../../src/infer/bench.ts';

const DIR = process.argv[2] ?? '.build/learn-test';
const out = `${DIR}/learned.json`;
execFileSync('npx', ['tsx', 'tools/learn/learn-logs.ts', '--logs', `${DIR}/logs`, '--out', out], { stdio: 'inherit' });
const PS = loadShowdown(); const dex = PS.Dex.forFormat(FORMAT);
const toID = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const base = JSON.parse(readFileSync('data/priors/sets.json', 'utf8'));
const learned = JSON.parse(readFileSync(out, 'utf8'));
const merged = mergePriors(base, learned);
const teams = JSON.parse(readFileSync('data/seed/teams_m7.json', 'utf8'));
const selections = JSON.parse(readFileSync('data/seed/selections_m7.json', 'utf8'));
const b0 = new BenchModel(teams, selections), b1 = new BenchModel(teams, selections, learned.bench);

// 型：本当の型（上位構築の型）の最初の確率。同じ種族・同じ型は1回だけ数える
const seenPairs = new Map<string, { sp: string; key: string }>();
for (const f of readdirSync(`${DIR}/logs`)) {
  const log = JSON.parse(readFileSync(`${DIR}/logs/${f}`, 'utf8'));
  const truth = JSON.parse(readFileSync(`${DIR}/truth/${f}`, 'utf8'));
  // 出てきた体：記録のどこかで場に出た体（相手の先発、交代先、倒れた後の場の体）
  const seen = new Set<number>([log.start.oppLead, ...log.turns.map((t: any) => t.input.after.oppActive)]);
  for (const i of seen) {
    const k = truth.oppIdx.indexOf(i); if (k < 0) continue;
    const m = truth.oppSets[k];
    const sp = base.species[toID(m.species)] ? toID(m.species) : toID(dex.species.get(m.species).baseSpecies);
    const key = seedKey(m);
    seenPairs.set(sp + '#' + key, { sp, key });
  }
}
let up = 0, down = 0, same = 0; const ratios: number[] = [];
for (const { sp, key } of seenPairs.values()) {
  const p = (e: any) => expandPrior(e).filter((c: any) => !c.generic && seedKey(c) === key).reduce((a: number, c: any) => a + c.prior, 0);
  const before = p(base.species[sp]), after = p(merged.species[sp]);
  if (after > before + 1e-12) up++; else if (after < before - 1e-12) down++; else same++;
  if (before > 0) ratios.push(after / before);
}
ratios.sort((a, b) => a - b);
console.log(`本当の型（種族と型の組 ${seenPairs.size}）：最初の確率が上がった ${up}、下がった ${down}、同じ ${same}。比（後/前）の中央値 ${ratios[Math.floor(ratios.length / 2)]?.toFixed(2)}`);

// 選出：記録のあった上位構築で、本当の3体の組の確率
let tUp = 0, tDown = 0;
for (const f of readdirSync(`${DIR}/truth`)) {
  const truth = JSON.parse(readFileSync(`${DIR}/truth/${f}`, 'utf8'));
  const team = teams.find((t: any) => t.rank === truth.rank);
  const sp = team.mons.map((m: any) => m.species);
  const k = [...truth.oppIdx].sort((a: number, b: number) => a - b).join(',');
  const p0 = b0.prior(sp, []).get(k) ?? 0, p1 = b1.prior(sp, []).get(k) ?? 0;
  if (p1 > p0 + 1e-12) tUp++; else if (p1 < p0 - 1e-12) tDown++;
}
console.log(`本当の選出（記録 ${readdirSync(`${DIR}/truth`).length} 件の3体の組）：確率が上がった ${tUp}、下がった ${tDown}`);
