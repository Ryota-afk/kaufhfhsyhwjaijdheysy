// 選出のおすすめの画面の確かめ（Playwright、Chromium）。先に npm run build と、確かめ用の表が必要：
//   npx tsx tools/select/precompute.ts --party .build/party-test.json --out .build/pc-test --ranks 1,3 --iters 5 --n0 1 --levels '' --minutes 10
//   npx tsx tools/select/finish.ts --root .build/pc-test
// 次を確かめる：
//  1. 表を保存した構築（1位）の6体を入れると、すぐに選出の確率の表と勝率が出て、くじの結果が準備欄に入る
//  2. 表のない構築の6体を入れると、近い構築からの見積もり＋その場の試合で、決めた時間の中で表が出る
//  3. ページのエラーがない
// 使い方：npx tsx tools/browser/select-e2e.ts [その場の計算の秒数=0（すぐ出す）]
import { spawn } from 'node:child_process';
import { readFileSync, cpSync, rmSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const SECS = Number(process.argv[2] ?? 0);
const ja = JSON.parse(readFileSync('data/names/ja.json', 'utf8'));
const party = JSON.parse(readFileSync('.build/party-test.json', 'utf8'));
const teams = JSON.parse(readFileSync('data/seed/teams_m7.json', 'utf8'));
const toID = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const J = (kind: string, n: string) => ja[kind][toID(n)] ?? n;
if (!existsSync('.build/pc-test/index.json')) throw new Error('確かめ用の表がありません（このファイルの先頭の手順を先に）');
// 公開用の出力に、確かめ用の表を置く（data/precomputed の代わり）
rmSync('dist/data/precomputed', { recursive: true, force: true });
cpSync('.build/pc-test', 'dist/data/precomputed', { recursive: true });

const server = spawn('npx', ['vite', 'preview', '--port', '4178', '--strictPort'], { stdio: 'ignore', detached: true });
const url = 'http://localhost:4178/kaufhfhsyhwjaijdheysy/battle.html';
for (let i = 0; i < 50; i++) { try { await fetch(url); break; } catch { await new Promise(r => setTimeout(r, 300)); } }
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1100 }, deviceScaleFactor: 1 });
const errors: string[] = [];
page.on('pageerror', (e: any) => errors.push(String(e)));
page.on('console', (m: any) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('worker', (w: any) => w.on('console', (m: any) => { if (m.type() === 'error') errors.push('worker: ' + m.text()); }));
await page.addInitScript(([p, ms]: any) => { localStorage.clear(); localStorage.setItem('champions.parties', JSON.stringify([p])); localStorage.setItem('champions.selectMs', String(ms)); }, [party, SECS * 1000]);
await page.goto(url);
await page.waitForSelector('#s-start', { timeout: 60000 });

const enterOpp = async (mons: any[]) => {
  for (let i = 0; i < 6; i++) { await page.fill(`.s-opp[data-i="${i}"]`, J('species', mons[i].species)); await page.dispatchEvent(`.s-opp[data-i="${i}"]`, 'change'); }
};
const readResult = async () => page.evaluate(() => {
  const el = document.getElementById('s-select')!;
  const picks = [...document.querySelectorAll<HTMLInputElement>('.s-pick')].filter(x => x.checked).map(x => Number(x.dataset.i));
  const lead = Number((document.querySelector('input[name="s-lead"]:checked') as HTMLInputElement | null)?.value ?? -1);
  return { text: el.innerText, rows: el.querySelectorAll('table tr').length - 1, picks, lead };
});
let ok = true;
const check = (cond: boolean, msg: string) => { console.log(`${cond ? '合格' : '不合格'}：${msg}`); if (!cond) ok = false; };
const valueOk = (text: string) => { const m = /釣り合いの勝率 (-?\d+)%/.exec(text); return !!m && Number(m[1]) >= 0 && Number(m[1]) <= 100; };

// 1. 表のある構築（1位）。並びを入れ替えて入れても同じ構築として見つける
const t1 = teams.find((t: any) => t.rank === 1);
const shuffled = [t1.mons[3], t1.mons[0], t1.mons[5], t1.mons[1], t1.mons[4], t1.mons[2]];
let t0 = Date.now();
await enterOpp(shuffled);
await page.waitForFunction(() => /くじの結果/.test(document.getElementById('s-select')!.innerText), null, { timeout: 30000 });
let r = await readResult();
console.log(`1位の構築：${((Date.now() - t0) / 1000).toFixed(1)}秒\n${r.text}`);
check(/保存した表/.test(r.text) && r.rows >= 1, '保存した表から、選出の確率の表が出た');
check(valueOk(r.text), '釣り合いの勝率が0〜100%');
check(r.picks.length === 3 && r.picks.includes(r.lead), `くじの結果が準備欄に入った（3体 ${r.picks}、先発 ${r.lead}）`);
check(Date.now() - t0 < 10000, '表のある構築は10秒以内に出た');

// 2. 表のない構築（5位）
const t5 = teams.find((t: any) => t.rank === 5) ?? teams[4];
t0 = Date.now();
await enterOpp(t5.mons);
await page.waitForFunction((rank: number) => { const t = document.getElementById('s-select')!.innerText; return /くじの結果/.test(t) && !t.includes(`${rank}位の構築`); }, 1, { timeout: (SECS + 60) * 1000 });
r = await readResult();
const sec = (Date.now() - t0) / 1000;
console.log(`表のない構築：${sec.toFixed(1)}秒\n${r.text}`);
if (SECS > 0) {
  check(/近い構築からの見積もり/.test(r.text) && /その場の試合/.test(r.text), '近い構築からの見積もりと、その場の試合で表が出た');
  check(sec < SECS + 15, `決めた時間（${SECS}秒）＋1試合分の中で出た（${sec.toFixed(1)}秒）`);
} else {
  check(/近い構築からの見積もり/.test(r.text) && !/その場の試合/.test(r.text), 'その場の試合なしで、近い構築からの見積もりだけで表が出た');
  check(sec < 5, `すぐに出た（${sec.toFixed(1)}秒）`);
}
check(r.picks.length === 3 && r.picks.includes(r.lead), 'くじの結果が準備欄に入った');
check(valueOk(r.text), '釣り合いの勝率が0〜100%');

await page.screenshot({ path: '.build/select.png', fullPage: true });
check(errors.length === 0, `ページのエラー ${errors.length}件 ${JSON.stringify(errors.slice(0, 5))}`);
await browser.close();
try { process.kill(-server.pid!); } catch { /* もう止まっている */ }
process.exit(ok ? 0 : 1);
