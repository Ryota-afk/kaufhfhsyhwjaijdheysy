// 探索の設定の比べ（指示文 4-5.）：今の設定（data/learn/settings.json）と、候補（data/learn/queue.json の先頭から）を
// AIどうしで対戦させ、2000試合以上で採用・不採用を決めて記録する。時間で区切り、次の回は続きから。
//  - 1組＝2試合：構築 X・Y と選出を決め、「今の設定が X で p1、候補が Y で p2」と「候補が X で p1、今の設定が Y で p2」。同じ乱数の種。
//  - 両者とも、見えた情報だけで推定し（src/learn/duel.ts）、1手 --iters 回探索する。
//  - 結果：data/learn/comparisons/<候補の番号>.json。決まったら data/learn/history.json に足し、採用なら settings.json を変える。
// 使い方：npx tsx tools/learn/compare.ts [--minutes 分] [--threads 数] [--iters 回数] [--dir data/learn]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { loadShowdown, FORMAT } from '../showdown/load.ts';
import { judge, DEFAULT_SETTINGS, RULE, type SearchSettings } from '../../src/learn/decide.ts';

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : d; };
const MINUTES = Number(arg('minutes', '10')), THREADS = Number(arg('threads', String(availableParallelism())));
const ITERS = Number(arg('iters', '8000')), DIR = arg('dir', 'data/learn');
// 確かめ用だけ：決めるのに要る試合数を変える（変えたときは記録に残る。裏の計算では使わない）
if (arg('min-games-for-test', '')) RULE.minGames = Number(arg('min-games-for-test', ''));
const deadline = Date.now() + MINUTES * 60 * 1000;
const readJson = (f: string, d: any) => existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : d;
const writeJson = (f: string, v: any) => writeFileSync(f, JSON.stringify(v, null, 1) + '\n');
mkdirSync(`${DIR}/comparisons`, { recursive: true });

const current: SearchSettings = readJson(`${DIR}/settings.json`, { ...DEFAULT_SETTINGS }).settings ?? { ...DEFAULT_SETTINGS };
const queue: { id: string; change: Partial<SearchSettings>; note: string }[] = readJson(`${DIR}/queue.json`, []);
const history: any[] = readJson(`${DIR}/history.json`, []);
const decided = new Set(history.map(h => h.id));
const item = queue.find(q => !decided.has(q.id));
if (!item) { console.log('比べる候補がありません（data/learn/queue.json）'); process.exit(0); }
const cand: SearchSettings = { ...current, ...item.change };
const recFile = `${DIR}/comparisons/${item.id}.json`;
let rec = readJson(recFile, null);
// 今の設定や探索の回数が変わっていたら、比べを最初からやり直す
if (!rec || JSON.stringify(rec.base) !== JSON.stringify(current) || JSON.stringify(rec.cand) !== JSON.stringify(cand) || rec.iters !== ITERS) {
  if (rec) console.log('今の設定・候補・探索の回数が保存した比べと違うので、最初からやり直します');
  rec = { id: item.id, note: item.note, base: current, cand, iters: ITERS, rule: RULE, pairs: [], halves: {}, errors: 0, errorSamples: [], gameSeconds: 0, games: 0, startedAt: new Date().toISOString() };
}
console.log(`比べ：${item.id}（${item.note}）。今 ${JSON.stringify(current)} ／ 候補 ${JSON.stringify(cand)}。1手 ${ITERS} 回、手伝い ${THREADS}、${MINUTES}分で区切る。保存済み ${rec.pairs.length} 組`);

// 構築と選出：組の番号から決まった乱数で選ぶ（続きから打っても同じ組になる）
const PS = loadShowdown();
const validator = PS.TeamValidator.get(FORMAT);
const teams = JSON.parse(readFileSync('data/seed/teams_m7.json', 'utf8')).filter((t: any) => !validator.validateTeam(t.mons.map((m: any) => ({ ...m, name: '', level: 50, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 } }))));
function pairSpec(p: number) {
  let st = (p * 2654435761 + 12345) >>> 0 || 1;
  const rand = () => { st = (st * 1664525 + 1013904223) >>> 0; return st / 4294967296; };
  const X = teams[Math.floor(rand() * teams.length)], Y = teams[Math.floor(rand() * teams.length)];
  const pick = () => { const a = [0, 1, 2, 3, 4, 5]; for (let i = 5; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, 3); };
  return { X, Y, ix: pick(), iy: pick(), seed: (p * 7919 + 1) >>> 0 };
}
// 半分 A：今の設定が X（p1）、候補が Y（p2）。半分 B：候補が X（p1）、今の設定が Y（p2）。得点は候補から見たもの
function duelOf(p: number, half: 'A' | 'B') {
  const s = pairSpec(p);
  return { teams: [s.X, s.Y], idx: [s.ix, s.iy], settings: half === 'A' ? [current, cand] : [cand, current], iters: ITERS, seed: s.seed };
}
const candScore = (half: 'A' | 'B', winner: 0 | 1 | null) => winner === null ? 0.5 : (half === 'A' ? (winner === 1 ? 1 : 0) : (winner === 0 ? 1 : 0));

const save = () => {
  const j = judge(rec.pairs);
  Object.assign(rec, { games: j.games, rate: j.rate, se: j.se, status: j.status, updatedAt: new Date().toISOString() });
  writeJson(recFile, rec);
  return j;
};

// 仕事の並び：途中の組の残りの半分、次に新しい組
const jobs: { p: number; half: 'A' | 'B' }[] = [];
for (const [p, h] of Object.entries(rec.halves as Record<string, any>)) for (const half of ['A', 'B'] as const) if (h[half] === undefined) jobs.push({ p: Number(p), half });
let nextPair = rec.pairs.length + Object.keys(rec.halves).length;
const needPairs = Math.ceil(RULE.minGames / 2);
const takeJob = () => {
  if (jobs.length) return jobs.shift()!;
  if (rec.pairs.length + Object.keys(rec.halves).length >= needPairs) return null;
  const p = nextPair++; rec.halves[p] = {}; jobs.push({ p, half: 'B' });
  return { p, half: 'A' as const };
};

const workers: Worker[] = [];
await Promise.all(Array.from({ length: THREADS }, () => new Promise<void>(res => {
  const w = new Worker(new URL('./compare-worker.ts', import.meta.url), { execArgv: ['--import', 'tsx'] });
  w.once('message', () => res()); workers.push(w);
})));
// 1試合の時間の見込み（打つたびに更新）。残り時間がこれより短ければ、新しい試合を始めない。最初は1手8000回で約5分（この計算機の測定）を回数で比例させる
let avgGameMs = Math.max(5000, 300000 * ITERS / 8000);
let played = 0;
const failed = new Map<string, number>();
await new Promise<void>(resolve => {
  let running = 0;
  const startOn = (w: Worker) => {
    const left = deadline - Date.now();
    const job = left > avgGameMs * 1.2 ? takeJob() : null;
    if (!job) { if (running === 0) resolve(); return; }
    running++;
    w.once('message', (m: any) => {
      running--;
      if (m.error) {
        rec.errors++; if (rec.errorSamples.length < 20) rec.errorSamples.push(m.error);
        // 同じ試合が2回続けて失敗したら、引き分け（0.5）として数える
        const k = `${job.p}${job.half}`; failed.set(k, (failed.get(k) ?? 0) + 1);
        if ((failed.get(k) ?? 0) < 2) jobs.unshift(job);
        else { const h = rec.halves[job.p] ?? (rec.halves[job.p] = {}); h[job.half] = 0.5; if (h.A !== undefined && h.B !== undefined) { rec.pairs.push([h.A, h.B]); delete rec.halves[job.p]; } save(); }
      }
      else {
        played++; rec.gameSeconds += m.ms / 1000;
        avgGameMs = 0.8 * avgGameMs + 0.2 * m.ms;
        if (m.errors.length) { rec.errors += m.errors.length; for (const e of m.errors) if (rec.errorSamples.length < 20) rec.errorSamples.push(e); }
        const h = rec.halves[job.p] ?? (rec.halves[job.p] = {});
        h[job.half] = candScore(job.half, m.winner);
        if (h.A !== undefined && h.B !== undefined) { rec.pairs.push([h.A, h.B]); delete rec.halves[job.p]; }
        const j = save();
        console.log(`試合 ${played}（組 ${job.p} の${job.half}）：${(m.ms / 1000).toFixed(0)}秒、${m.turns}ターン。ここまで ${j.games}試合、候補の勝率 ${j.rate.toFixed(3)} ± ${(2 * j.se).toFixed(3)}`);
      }
      startOn(w);
    });
    w.postMessage({ key: `${job.p}${job.half}`, duel: duelOf(job.p, job.half) });
  };
  for (const w of workers) startOn(w);
});
for (const w of workers) await w.terminate();

const j = save();
if (j.status !== '途中') {
  rec.decidedAt = new Date().toISOString(); writeJson(recFile, rec);
  history.push({ id: rec.id, note: rec.note, base: rec.base, cand: rec.cand, iters: rec.iters, games: j.games, rate: Math.round(j.rate * 1e4) / 1e4, se: Math.round(j.se * 1e4) / 1e4, status: j.status, rule: `${RULE.minGames}試合以上、勝率${RULE.minRate}以上、かつ勝率−2×誤差>0.5`, decidedAt: rec.decidedAt });
  writeJson(`${DIR}/history.json`, history);
  if (j.status === '採用') writeJson(`${DIR}/settings.json`, { settings: cand, adoptedFrom: rec.id, adoptedAt: rec.decidedAt });
  console.log(`決定：${rec.id} を${j.status}（${j.games}試合、候補の勝率 ${j.rate.toFixed(3)}、誤差 ${j.se.toFixed(3)}）`);
} else console.log(`区切り：${rec.id}、${j.games}試合（今回 ${played}）。決めるには ${RULE.minGames}試合以上が要る`);
