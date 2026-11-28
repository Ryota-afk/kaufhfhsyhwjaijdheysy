// 探索の設定の比べ（指示文 4-5.）：今の設定（data/learn/settings.json）と、候補（data/learn/queue.json の先頭から）を
// AIどうしで対戦させ、2000試合以上で採用・不採用を決めて記録する。時間で区切り、次の回は続きから。
//  - 1組＝2試合：構築 X・Y と選出を決め、「今の設定が X で p1、候補が Y で p2」と「候補が X で p1、今の設定が Y で p2」。同じ乱数の種。
//  - 両者とも、見えた情報だけで推定し（src/learn/duel.ts）、1手 --iters 回探索する。
//  - 組の番号は 0〜999（2000試合分）。分担 k（全部で S）は、番号を S で割った余りが k の組だけを打つ。
//  - 分担は自分の途中のファイル data/learn/comparisons/<候補>.shard<k>.json にだけ書く（並べて動かしてもぶつからない）。
//  - まとめ（--merge）：分担のファイルを data/learn/comparisons/<候補>.json に足し、分担のファイルを消す。
//    決まったら data/learn/history.json に足し、採用なら settings.json を変える。
// 使い方：npx tsx tools/learn/compare.ts [--minutes 分] [--shard 番号 --shards 数] [--threads 数] [--iters 回数] [--dir data/learn]
//         npx tsx tools/learn/compare.ts --merge [--iters 回数] [--dir data/learn]
//   --shards を渡さない（1つで動かす）ときは、打った後にそのまままとめる。
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { loadShowdown, FORMAT } from '../showdown/load.ts';
import { judge, DEFAULT_SETTINGS, RULE, type SearchSettings } from '../../src/learn/decide.ts';

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : d; };
const MERGE = process.argv.includes('--merge');
const MINUTES = Number(arg('minutes', '10')), THREADS = Number(arg('threads', String(availableParallelism())));
const SHARD = Number(arg('shard', '0')), SHARDS = Number(arg('shards', '1'));
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
const shardFile = (k: number) => `${DIR}/comparisons/${item.id}.shard${k}.json`;
const needPairs = Math.ceil(RULE.minGames / 2);
const sameRun = (r: any) => !!r && JSON.stringify(r.base) === JSON.stringify(current) && JSON.stringify(r.cand) === JSON.stringify(cand) && r.iters === ITERS;

type Halves = Record<string, { A?: number; B?: number }>;
/** まとめた記録を読む。前の形（pairs が配列、組の番号なし）は、番号つき（done）に直す。 */
function loadMain() {
  let rec = readJson(recFile, null);
  if (rec && !sameRun(rec)) { console.log('今の設定・候補・探索の回数が保存した比べと違うので、最初からやり直します'); rec = null; }
  if (!rec) rec = { id: item!.id, note: item!.note, base: current, cand, iters: ITERS, rule: RULE, done: {}, halves: {}, errors: 0, errorSamples: [], gameSeconds: 0, games: 0, startedAt: new Date().toISOString() };
  if (Array.isArray(rec.pairs)) {
    // 前の形：組の番号は 0 から順に配っていた。配った番号のうち、途中（halves）でないものが、そろった組
    const n = rec.pairs.length + Object.keys(rec.halves ?? {}).length;
    const doneIdx = Array.from({ length: n }, (_, p) => p).filter(p => !(String(p) in (rec.halves ?? {})));
    rec.done = Object.fromEntries(doneIdx.map((p, i) => [String(p), rec.pairs[i]]));
    delete rec.pairs;
  }
  rec.done ??= {}; rec.halves ??= {};
  return rec;
}
const judgeOf = (rec: any) => judge(Object.values(rec.done) as [number, number][]);

// 構築と選出：組の番号から決まった乱数で選ぶ（続きから打っても、どの分担が打っても同じ組になる）
function pairSpec(teams: any[], p: number) {
  let st = (p * 2654435761 + 12345) >>> 0 || 1;
  const rand = () => { st = (st * 1664525 + 1013904223) >>> 0; return st / 4294967296; };
  const X = teams[Math.floor(rand() * teams.length)], Y = teams[Math.floor(rand() * teams.length)];
  const pick = () => { const a = [0, 1, 2, 3, 4, 5]; for (let i = 5; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, 3); };
  return { X, Y, ix: pick(), iy: pick(), seed: (p * 7919 + 1) >>> 0 };
}
// 半分 A：今の設定が X（p1）、候補が Y（p2）。半分 B：候補が X（p1）、今の設定が Y（p2）。得点は候補から見たもの
const candScore = (half: 'A' | 'B', winner: 0 | 1 | null) => winner === null ? 0.5 : (half === 'A' ? (winner === 1 ? 1 : 0) : (winner === 0 ? 1 : 0));

/** 分担 SHARD として、時間まで打つ。結果は分担のファイルにだけ書く。 */
async function play() {
  const main = loadMain();
  let sh = readJson(shardFile(SHARD), null);
  if (sh && !sameRun(sh)) sh = null;   // 前の設定の途中は使わない（まとめのときに消える）
  sh ??= { base: current, cand, iters: ITERS, shard: SHARD, shards: SHARDS, done: {}, halves: {}, errors: 0, errorSamples: [], gameSeconds: 0 };
  const mineP = (p: number) => p % SHARDS === SHARD;
  const doneAll = (p: number) => String(p) in main.done || String(p) in sh.done;
  const halfOf = (p: number): { A?: number; B?: number } => ({ ...(main.halves[p] ?? {}), ...(sh.halves[p] ?? {}) });
  // 仕事の並び：途中の組の残りの半分、次に新しい組（番号の小さい順）
  const jobs: { p: number; half: 'A' | 'B' }[] = [];
  const started = new Set<number>();
  for (const p of new Set([...Object.keys(main.halves), ...Object.keys(sh.halves)].map(Number))) {
    if (!mineP(p) || doneAll(p)) continue;
    started.add(p);
    const h = halfOf(p);
    for (const half of ['A', 'B'] as const) if (h[half] === undefined) jobs.push({ p, half });
  }
  let nextP = SHARD;
  const takeJob = () => {
    if (jobs.length) return jobs.shift()!;
    while (nextP < needPairs && (doneAll(nextP) || started.has(nextP))) nextP += SHARDS;
    if (nextP >= needPairs) return null;
    const p = nextP; nextP += SHARDS; started.add(p); jobs.push({ p, half: 'B' });
    return { p, half: 'A' as const };
  };
  const total = () => Object.keys(main.done).length + Object.keys(sh.done).length;
  console.log(`比べ：${item!.id}（${item!.note}）。今 ${JSON.stringify(current)} ／ 候補 ${JSON.stringify(cand)}。1手 ${ITERS} 回、分担 ${SHARD}/${SHARDS}、手伝い ${THREADS}、${MINUTES}分で区切る。まとめ済み ${Object.keys(main.done).length} 組、この分担の途中 ${Object.keys(sh.done).length} 組`);

  const PS = loadShowdown();
  const validator = PS.TeamValidator.get(FORMAT);
  const teams = JSON.parse(readFileSync('data/seed/teams_m7.json', 'utf8')).filter((t: any) => !validator.validateTeam(t.mons.map((m: any) => ({ ...m, name: '', level: 50, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 } }))));
  const duelOf = (p: number, half: 'A' | 'B') => {
    const s = pairSpec(teams, p);
    return { teams: [s.X, s.Y], idx: [s.ix, s.iy], settings: half === 'A' ? [current, cand] : [cand, current], iters: ITERS, seed: s.seed };
  };
  const record = (p: number, half: 'A' | 'B', v: number) => {
    const h = sh.halves[p] ?? (sh.halves[p] = {});
    h[half] = v;
    const all = halfOf(p);
    if (all.A !== undefined && all.B !== undefined) { sh.done[p] = [all.A, all.B]; delete sh.halves[p]; }
    writeJson(shardFile(SHARD), sh);
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
          sh.errors++; if (sh.errorSamples.length < 20) sh.errorSamples.push(m.error);
          // 同じ試合が2回続けて失敗したら、引き分け（0.5）として数える
          const k = `${job.p}${job.half}`; failed.set(k, (failed.get(k) ?? 0) + 1);
          if ((failed.get(k) ?? 0) < 2) jobs.unshift(job); else record(job.p, job.half, 0.5);
        } else {
          played++; sh.gameSeconds += m.ms / 1000;
          avgGameMs = 0.8 * avgGameMs + 0.2 * m.ms;
          if (m.errors.length) { sh.errors += m.errors.length; for (const e of m.errors) if (sh.errorSamples.length < 20) sh.errorSamples.push(e); }
          record(job.p, job.half, candScore(job.half, m.winner));
          console.log(`試合 ${played}（組 ${job.p} の${job.half}）：${(m.ms / 1000).toFixed(0)}秒、${m.turns}ターン。そろった組 ${total()}（まとめ済み＋この分担）`);
        }
        startOn(w);
      });
      w.postMessage({ key: `${job.p}${job.half}`, duel: duelOf(job.p, job.half) });
    };
    for (const w of workers) startOn(w);
  });
  for (const w of workers) await w.terminate();
  writeJson(shardFile(SHARD), sh);
  console.log(`区切り：分担 ${SHARD}/${SHARDS}、今回 ${played}試合、この分担のそろった組 ${Object.keys(sh.done).length}、途中の組 ${Object.keys(sh.halves).length}`);
}

/** 分担のファイルをまとめの記録に足して消し、判定する。 */
function merge() {
  const rec = loadMain();
  const prefix = `${item!.id}.shard`;
  const files = readdirSync(`${DIR}/comparisons`).filter(f => f.startsWith(prefix) && f.endsWith('.json'));
  let added = 0;
  for (const f of files) {
    const path = `${DIR}/comparisons/${f}`;
    const sh = readJson(path, null);
    if (sameRun(sh)) {
      for (const [p, v] of Object.entries(sh.done as Record<string, [number, number]>)) if (!(p in rec.done)) { rec.done[p] = v; delete rec.halves[p]; added++; }
      for (const [p, h] of Object.entries(sh.halves as Halves)) {
        if (p in rec.done) continue;
        const all = { ...(rec.halves[p] ?? {}), ...h };
        if (all.A !== undefined && all.B !== undefined) { rec.done[p] = [all.A, all.B]; delete rec.halves[p]; added++; } else rec.halves[p] = all;
      }
      rec.errors += sh.errors; rec.gameSeconds += sh.gameSeconds;
      for (const e of sh.errorSamples) if (rec.errorSamples.length < 20) rec.errorSamples.push(e);
    } else console.log(`使わない：${f}（今の設定・候補・探索の回数と違う）`);
    unlinkSync(path);
  }
  const j = judgeOf(rec);
  Object.assign(rec, { games: j.games, rate: j.rate, se: j.se, status: j.status, updatedAt: new Date().toISOString() });
  writeJson(recFile, rec);
  console.log(`まとめ：分担のファイル ${files.length}、足した組 ${added}。${item!.id}：${j.games}試合、候補の勝率 ${j.rate.toFixed(3)} ± ${(2 * j.se).toFixed(3)}`);
  if (j.status !== '途中') {
    rec.decidedAt = new Date().toISOString(); writeJson(recFile, rec);
    history.push({ id: rec.id, note: rec.note, base: rec.base, cand: rec.cand, iters: rec.iters, games: j.games, rate: Math.round(j.rate * 1e4) / 1e4, se: Math.round(j.se * 1e4) / 1e4, status: j.status, rule: `${RULE.minGames}試合以上、勝率${RULE.minRate}以上、かつ勝率−2×誤差>0.5`, decidedAt: rec.decidedAt });
    writeJson(`${DIR}/history.json`, history);
    if (j.status === '採用') writeJson(`${DIR}/settings.json`, { settings: cand, adoptedFrom: rec.id, adoptedAt: rec.decidedAt });
    console.log(`決定：${rec.id} を${j.status}（${j.games}試合、候補の勝率 ${j.rate.toFixed(3)}、誤差 ${j.se.toFixed(3)}）`);
  } else console.log(`途中：決めるには ${RULE.minGames}試合以上が要る`);
}

if (MERGE) merge();
else { await play(); if (!process.argv.includes('--shards')) merge(); }
