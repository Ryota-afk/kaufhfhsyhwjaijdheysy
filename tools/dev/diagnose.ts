// 開発用：照合でずれた盤面を、速さの層の部分ごとに入り切りして打ち直し、どの部分が原因かを調べる。
// 使い方：npx tsx tools/dev/diagnose.ts 盤面の数 盤面を作る種 盤面番号 乱数の種
import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { loadShowdown, FORMAT } from '../showdown/load.ts';
import { ShowdownRunner } from '../compare/showdown-adapter.ts';
import { genPosition, Rng } from '../compare/gen.ts';
import { runJob, type Job } from '../compare/play.ts';
import type { Action } from '../../src/engine/position.ts';
const [NPOS, GSEED, IDX, SEED] = process.argv.slice(2).map(Number);
const PS = loadShowdown();
const dex = PS.Dex.forFormat(FORMAT);
const validator = PS.TeamValidator.get(FORMAT);
const teams = JSON.parse(readFileSync('data/seed/teams_m7.json', 'utf8')).filter((t: any) => !validator.validateTeam(t.mons.map((m: any) => ({ ...m, name: '', level: 50, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 } }))));
const rng = new Rng(GSEED);
let job: Job | undefined; let n = 0;
while (n <= IDX) {
  const pos = genPosition(rng, teams, dex);
  try {
    const r = new ShowdownRunner(pos, 1);
    const pick = (si: number): Action => { const l = r.legalActions(si); const mv = l.filter(a => a.kind === 'move'); return (mv.length && rng.chance(0.75)) ? rng.pick(mv) : rng.pick(l); };
    const first: [Action, Action] = [pick(0), pick(1)];
    if (n === IDX) job = { pos, first, seeds: [SEED], turns: 3 };
    n++;
  } catch { /* 作り直し */ }
}
let refLog: string[] = [];
const ref = runJob(job!, undefined, r => { refLog = r.battle.log.filter((l: string) => !l.startsWith('|t:|')); })[0];
console.log('最初の行動', JSON.stringify(job!.first), '後の行動', ref.moves);
const variants: [string, any][] = [
  ['すべて', { layer: { noLog: true, events: true, activeMove: true }, clone: true }],
  ['複製だけ', { layer: {}, clone: true }],
  ['記録停止だけ', { layer: { noLog: true }, clone: false }],
  ['処理先だけ', { layer: { events: true }, clone: false, wantLog: true }],
  ['技の写しだけ', { layer: { activeMove: true }, clone: false }],
];
for (const [name, cfg] of variants) {
  const w = new Worker(new URL('../compare/worker.ts', import.meta.url), { execArgv: ['--import', 'tsx'], workerData: cfg });
  let res: any = await new Promise(r => { w.on('message', r); w.postMessage([job]); });
  if (res.logs) {
    const L = res.logs[0].filter((l: string) => !l.startsWith('|t:|'));
    const i = refLog.findIndex((x, k) => x !== L[k]);
    console.log(`--- ${name}：記録の最初の違い（${i}行目）`);
    console.log('Showdown:', refLog.slice(Math.max(0, i - 6), i + 4).join('\n  '));
    console.log('エンジン:', L.slice(Math.max(0, i - 6), i + 4).join('\n  '));
    res = res.res;
  }
  await w.terminate();
  const same = JSON.stringify(res[0][0].outcome) === JSON.stringify(ref.outcome);
  console.log(name, same ? '一致' : '不一致');
  if (!same && cfg.layer.events && !cfg.layer.noLog) {
    // 記録の最初の違い
  }
}
