// 対戦の画面の通しの確かめ（Playwright、Chromium）。先に npm run build が必要。
// Node で Showdown の対戦（こちら：利用者のチーム2から3体、相手：上位構築から3体）を本当に打ち、毎ターン、
// 画面に見えることだけを利用者と同じ操作で入れる。次を確かめる：
//  1. 毎ターン、上位3手が出る。「記録して計算」から表示までの時間
//  2. 1ターンの入力の操作の回数
//  3. 途中でページを読み込み直しても、記録から同じ盤面に戻る
//  4. ページのエラーがない
// 使い方：npx tsx tools/browser/battle-e2e.ts [ターン数=8] [計算の秒数=10] [種=1]
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loadShowdown, FORMAT } from '../showdown/load.ts';
import { makeRunner } from '../../src/engine/runner.ts';
import { shownPercent } from '../../src/infer/calc.ts';
import type { Action, Position, StatusID } from '../../src/engine/position.ts';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const [TURNS, SECS, SEED] = [8, 10, 1].map((d, i) => Number(process.argv[2 + i] ?? d));
const PS = loadShowdown();
const dex = PS.Dex.forFormat(FORMAT);
const Runner = makeRunner(PS, FORMAT);
const ja = JSON.parse(readFileSync('data/names/ja.json', 'utf8'));
const party = JSON.parse(readFileSync('test/fixtures/party-team2-screen.json', 'utf8'));
const teams = JSON.parse(readFileSync('data/seed/teams_m7.json', 'utf8'));
const toID = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const J = (kind: string, n: string) => ja[kind][toID(n)] ?? n;
let st = SEED * 101 + 3; const rand = () => { st = (st * 16807) % 2147483647; return st / 2147483647; };

// 本当の対戦
const team = teams.find((t: any) => t.rank === 4);   // 4位の構築
const ourIdx = [0, 1, 2], oppIdx = [0, 1, 2];
const setOf = (m: any) => ({ species: m.species, item: toID(m.item), ability: toID(m.ability), nature: m.nature, evs: m.evs, moves: m.moves.map(toID) });
const truthPos: Position = { sides: [
  { mons: ourIdx.map(i => ({ set: setOf(party[i]), hp: 999, status: '' as StatusID })), active: 0 },
  { mons: oppIdx.map(i => ({ set: setOf(team.mons[i]), hp: 999, status: '' as StatusID })), active: 0 },
] };
const truth = new Runner(truthPos, SEED, true);
const b = truth.battle;

const server = spawn('npx', ['vite', 'preview', '--port', '4177', '--strictPort'], { stdio: 'ignore', detached: true });
const url = 'http://localhost:4177/kaufhfhsyhwjaijdheysy/battle.html';
for (let i = 0; i < 50; i++) { try { await fetch(url); break; } catch { await new Promise(r => setTimeout(r, 300)); } }
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 1 });
const errors: string[] = [];
page.on('pageerror', (e: any) => errors.push(String(e)));
page.on('console', (m: any) => { if (m.type() === 'error' || m.type() === 'warning') errors.push('console: ' + m.text()); });
page.on('worker', (w: any) => w.on('console', (m: any) => errors.push('worker: ' + m.text())));
// 保存済みのパーティ（チーム2）と計算時間をブラウザに入れておく
const partyDoc = { id: 'p-test', name: 'チーム2', updatedAt: '', mons: party.map((m: any) => ({ species: m.species, item: m.item, ability: m.ability, nature: m.nature, evs: m.evs, moves: m.moves, gender: m.gender })) };
await page.addInitScript(([p, ms]: any) => { if (!localStorage.getItem('champions.parties')) localStorage.setItem('champions.parties', JSON.stringify([p])); localStorage.setItem('champions.searchMs', String(ms)); }, [partyDoc, SECS * 1000]);
await page.goto(url);
await page.waitForSelector('#s-start', { timeout: 60000 });

let ops = 0;
const click = async (sel: string) => { await page.click(sel); ops++; };
const fill = async (sel: string, v: string) => { await page.fill(sel, v); await page.dispatchEvent(sel, 'change'); ops++; };
const select = async (sel: string, v: string) => { await page.selectOption(sel, v); ops++; };

// 準備
for (const i of ourIdx) await click(`.s-pick[data-i="${i}"]`);
await click(`input[name="s-lead"][value="${ourIdx[0]}"]`);
for (let i = 0; i < 6; i++) await fill(`.s-opp[data-i="${i}"]`, J('species', team.mons[i].species));
await click(`input[name="s-opplead"][value="${oppIdx[0]}"]`);
// 先発の特性・持ち物の発動
const startLines: string[] = b.log;
const leadAb = startLines.map(l => /^\|-ability\|p2a: [^|]*\|([^|]*)/.exec(l)?.[1]).find(Boolean);
if (leadAb) await select('#s-oppab', toID(leadAb));
const setupOps = ops; ops = 0;
await click('#s-start');
const results: { turn: number; ms: number; ops: number; top: string[] }[] = [];
const waitResult = async () => {
  const t0 = Date.now();
  try {
    await page.waitForFunction(() => { const w = (window as any).__battle; return w && !w.searching && w.result; }, null, { timeout: (SECS + 60) * 1000 });
  } catch (e) {
    console.log('画面：', (await page.evaluate(() => document.body.innerHTML.length)), (await page.textContent('body'))?.slice(0, 400));
    console.log('エラー：', errors); await page.screenshot({ path: '.build/battle-timeout.png', fullPage: true }); console.log('状態', await page.evaluate(() => { const w = (window as any).__battle; return JSON.stringify({ searching: w?.searching, hasView: !!w?.view, hasResult: !!w?.result, turns: w?.doc?.turns?.length }); }));
    throw e;
  }
  return Date.now() - t0;
};
let ms = await waitResult();
results.push({ turn: 0, ms, ops: 0, top: await page.$$eval('#result tr td strong', (xs: any[]) => xs.map(x => x.textContent)) });

for (let t = 0; t < TURNS && !b.ended; t++) {
  // 本当の対戦を1ターン進める（両者ランダム）
  const l0 = truth.legalActions(0), l1 = truth.legalActions(1);
  const before = b.turn; const logFrom = b.log.length;
  const oppActiveBefore = b.sides[1].active[0];
  let a0: Action | null = null, a1: Action | null = null;
  for (let k = 0; k < 8 && b.turn === before && !b.ended; k++) {
    a0 = l0[Math.floor(rand() * l0.length)] ?? null; a1 = l1[Math.floor(rand() * l1.length)] ?? null;
    // メガシンカは入力欄を試すため、選べるなら選ぶ
    truth.play(a0, a1);
  }
  if (b.ended || b.turn === before) break;
  const lines: string[] = b.log.slice(logFrom);
  const own = (l: string) => !l.includes('[from]') || l.includes('[from] lockedmove');
  const moveLines = lines.filter(l => /^\|move\|p[12]a:/.test(l) && own(l));
  const oppMoveLine = lines.find(l => l.startsWith(`|move|p2a: ${oppActiveBefore.name}|`) && own(l));
  ops = 0;
  // こちらの行動
  const ourMoved = lines.some(l => l.startsWith('|move|p1a') && own(l));
  if (a0?.kind === 'switch') await click(`input[name="t-our"][value="switch ${a0.to}"]`);
  else if (a0?.kind === 'move' && ourMoved) await click(`input[name="t-our"][value="move ${a0.slot}"]`);
  else await click('input[name="t-our"][value="none"]');
  if (lines.some(l => l.startsWith('|-mega|p1a'))) await click('#t-ourmega');
  // 相手の行動
  if (a1?.kind === 'switch') await click(`input[name="t-opp"][value="switch ${oppIdx[a1.to]}"]`);
  else if (oppMoveLine) {
    const mv = oppMoveLine.split('|')[3];
    const btn = await page.$(`input[name="t-opp"][value="move ${toID(mv)}"]`) ?? await page.$(`input[name="t-opp"][value="move ${mv}"]`);
    if (btn) { await btn.click(); ops++; } else { await click('input[name="t-opp"][value="other"]'); await fill('#t-oppmove', J('moves', mv)); }
  } else await click('input[name="t-opp"][value="none"]');
  if (lines.some(l => l.startsWith('|-mega|p2a'))) await click('#t-oppmega');
  const ourMovedMove = a0?.kind === 'move' && ourMoved, oppMoved = a1?.kind !== 'switch' && !!oppMoveLine;
  if (ourMovedMove && oppMoved && moveLines.length >= 2) await click(`input[name="t-first"][value="${moveLines[0].startsWith('|move|p2a') ? 'them' : 'us'}"]`);
  if (lines.some(l => l.startsWith('|-crit|p2a'))) await click('#t-critopp');
  if (lines.some(l => l.startsWith('|-crit|p1a'))) await click('#t-critus');
  // ターンの後
  const s0 = b.sides[0].active[0], s1 = b.sides[1].active[0];
  const ourActive = ourIdx.findIndex(i => dex.species.get(party[i].species).baseSpecies === s0.baseSpecies.baseSpecies);
  const oppActive6 = team.mons.findIndex((m: any) => dex.species.get(m.species).baseSpecies === s1.baseSpecies.baseSpecies);
  const curOurActive = await page.$eval('#t-ouractive', (x: any) => x.value);
  if (String(ourActive) !== curOurActive) await select('#t-ouractive', String(ourActive));
  for (const [k, i] of ourIdx.entries()) {
    const hp = b.sides[0].pokemon.find((p: any) => p.baseSpecies.baseSpecies === dex.species.get(party[i].species).baseSpecies).hp;
    const cur = await page.$eval(`.t-ourhp[data-i="${k}"]`, (x: any) => x.value);
    if (String(hp) !== cur) await fill(`.t-ourhp[data-i="${k}"]`, String(hp));
  }
  const curOurSt = await page.$eval('#t-ourstatus', (x: any) => x.value);
  if ((s0.status || '') !== curOurSt) await select('#t-ourstatus', s0.status || '');
  const curOpp = await page.$eval('#t-oppactive', (x: any) => x.value);
  if (String(oppActive6) !== curOpp) await select('#t-oppactive', String(oppActive6));
  const pct = shownPercent(s1.hp, s1.maxhp);
  if (String(pct) !== await page.$eval('#t-opphp', (x: any) => x.value)) await fill('#t-opphp', String(pct));
  if ((s1.status || '') !== await page.$eval('#t-oppstatus', (x: any) => x.value)) await select('#t-oppstatus', s1.status || '');
  const turnOps = ops;
  await page.click('#t-record');
  const ms2 = await waitResult();
  results.push({ turn: t + 1, ms: ms2, ops: turnOps + 1, top: await page.$$eval('#result tr td strong', (xs: any[]) => xs.map(x => x.textContent)) });
  // 3ターン目の後で読み込み直す
  if (t === 2) {
    const before = await page.evaluate(() => JSON.stringify((window as any).__battle.view.pos));
    console.log('読み込み直す前', await page.evaluate(() => JSON.stringify({ turns: (window as any).__battle.doc.turns.length, vt: (window as any).__battle.view.turn, ls: JSON.parse(localStorage.getItem('champions.currentBattle')!).turns.length })));
    await page.reload();
    await waitResult();
    const after = await page.evaluate(() => JSON.stringify((window as any).__battle.view.pos));
    console.log('読み込み直した後', await page.evaluate(() => JSON.stringify({ turns: (window as any).__battle.doc.turns.length, vt: (window as any).__battle.view.turn })));
    console.log(before === after ? '合格：読み込み直しても、記録から同じ盤面に戻った' : '不合格：読み込み直すと盤面が変わった');
    if (before !== after) {
      const A = JSON.parse(before), B = JSON.parse(after);
      const walk = (a: any, b: any, path: string) => {
        if (JSON.stringify(a) === JSON.stringify(b)) return;
        if (a && b && typeof a === 'object' && typeof b === 'object') { for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[k], b[k], path + '.' + k); return; }
        console.log('  違い', path, JSON.stringify(a), '→', JSON.stringify(b));
      };
      walk(A, B, 'pos');
    }
  }
}
await page.screenshot({ path: '.build/battle.png', fullPage: true });
await browser.close();
try { process.kill(-server.pid!); } catch { /* もう止まっている */ }
for (const r of results) console.log(`ターン${r.turn}：上位 ${r.top.join(' ／ ')}（${r.top.length}手）、記録→表示 ${(r.ms / 1000).toFixed(1)}秒、操作 ${r.ops}回`);
console.log(`準備の操作 ${setupOps}回`);
const allThree = results.every(r => r.top.length >= 2);
console.log(`${allThree ? '合格' : '不合格'}：毎ターン、上位の手が出た`);
console.log(`${errors.length ? '不合格' : '合格'}：ページのエラー ${errors.length}件`, errors.slice(0, 3));
writeFileSync('.build/battle-e2e.json', JSON.stringify({ results, setupOps, errors }, null, 1));
process.exitCode = allThree && !errors.length ? 0 : 1;
