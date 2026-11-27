// ブラウザ（Chromium、Playwright）で Showdown を動かし、
//  A. Node の Showdown と乱数の種ごとに結果が一致するか（Showdown そのまま／速さの層あり＋複製）
//  B. 1秒あたりのターン数と複製の時間
// を確かめて、.build/browser-check.json に書く。先に npm run build が必要。
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { makeJobs } from './jobs.ts';
import { runJob } from '../compare/play.ts';

const [NPOS, NSEED, BENCH_SECS] = [200, 5, 20].map((d, i) => Number(process.argv[2 + i] ?? d));
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const jobs = makeJobs(NPOS, NSEED, 3, 11);
const ref = jobs.map(j => runJob(j));

const server = spawn('npx', ['vite', 'preview', '--port', '4174', '--strictPort'], { stdio: 'ignore', detached: true });
const url = 'http://localhost:4174/kaufhfhsyhwjaijdheysy/bench.html';
for (let i = 0; i < 50; i++) { try { await fetch(url); break; } catch { await new Promise(r => setTimeout(r, 300)); } }
const browser = await chromium.launch();
const page = await browser.newPage();
const errors: string[] = [];
page.on('pageerror', (e: any) => errors.push(String(e)));
await page.goto(url);
await page.waitForFunction(() => typeof (window as any).__runJobs === 'function', null, { timeout: 30000 }).catch(() => console.log('ページの準備ができない', errors));

const out: any = { npos: NPOS, nseed: NSEED };
for (const layer of [false, true]) {
  const res = await page.evaluate(([j, l]: any) => (window as any).__runJobs(j, l), [jobs, layer]);
  let same = 0, total = 0; const bad: string[] = [];
  for (let i = 0; i < jobs.length; i++) for (let k = 0; k < ref[i].length; k++) {
    total++;
    const a = JSON.stringify(ref[i][k].outcome ?? ref[i][k].error), b = JSON.stringify(res[i][k].outcome ?? res[i][k].error);
    if (a === b) same++; else if (bad.length < 3) bad.push(`盤面${i} 種${jobs[i].seeds[k]}`);
  }
  out[layer ? 'matchLayer' : 'matchPlain'] = { same, total, bad };
  console.log(`${layer ? '速さの層あり' : 'Showdown そのまま'}：Node と一致 ${same} / ${total}`, bad.join(' '));
}
if (BENCH_SECS > 0) {
  const b = await page.evaluate((s: number) => (window as any).__bench(s), BENCH_SECS);
  out.bench = b;
  for (const r of b.results) console.log(`${r.layer ? '速さの層あり' : 'Showdown そのまま'}：1秒あたり ${Math.round(r.turnsPerSec)} ターン、複製1回 ${Math.round(r.cloneUs)}µs（${r.games}試合）`);
  for (const r of b.iter) console.log(`探索1回相当（複製＋2ターン）：Worker ${r.workers}つで1秒あたり ${Math.round(r.itersPerSec)} 回`);
  console.log('論理コア数', b.cores, b.ua);
}
if (errors.length) console.log('ページのエラー：', errors);
writeFileSync('.build/browser-check.json', JSON.stringify(out, null, 1));
await browser.close();
process.kill(-server.pid!);
