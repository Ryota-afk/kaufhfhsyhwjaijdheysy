// ブラウザ用に組み立てた Showdown（.build/showdown-browser.mjs）を Node で読み込み、元の Showdown と種ごとに一致するかを見る。
import { makeJobs } from './jobs.ts';
import { runJob } from '../compare/play.ts';
import { runJobWith } from '../../src/engine/play.ts';
import { makeRunner } from '../../src/engine/runner.ts';
import { FORMAT } from '../showdown/load.ts';
const { PS } = await import('../../.build/showdown-browser.mjs' as any);
const Runner = makeRunner(PS, FORMAT);
const jobs = makeJobs(200, 5, 3, 11);
let same = 0, total = 0; const bad: string[] = [];
for (const [i, job] of jobs.entries()) {
  const a = runJob(job), b = runJobWith(Runner, job);
  for (let k = 0; k < a.length; k++) {
    total++;
    const x = JSON.stringify(a[k].outcome ?? a[k].error), y = JSON.stringify(b[k].outcome ?? b[k].error);
    if (x === y) same++; else if (bad.length < 5) bad.push(`盤面${i} 種${job.seeds[k]}\n  元:${x.slice(0, 300)}\n  組:${y.slice(0, 300)}`);
  }
}
console.log(`一致 ${same} / ${total}`); bad.forEach(x => console.log(x));
