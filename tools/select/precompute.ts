// 先回りの計算：「よく使う」の印をつけたパーティ × 上位構築ごとに、選出の表（60×60）を AIどうしの対戦で埋め、
// data/precomputed/<パーティの番号>/<構築の順位>.json に保存する。時間で区切り、次の回は保存した数から続ける。
// 使い方：npx tsx tools/select/precompute.ts [--minutes 分] [--shard 番号 --shards 数] [--threads 数] [--party ファイル] [--ranks 1,3,4]
//   確かめ用：[--out 保存先] [--iters 探索の回数 --n0 最初の試合数 --levels 16,32,64]
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { partyKey as keyOf, plainSet } from '../../src/select/key.ts';
import { Worker } from 'node:worker_threads';
import { loadShowdown, FORMAT } from '../showdown/load.ts';
import { emptyStats, nextWork, solveTable, allowedRows, SIZE, type TableStats } from '../../src/select/table.ts';

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : d; };
const MINUTES = Number(arg('minutes', '10')), SHARD = Number(arg('shard', '0')), SHARDS = Number(arg('shards', '1'));
const THREADS = Number(arg('threads', String(availableParallelism())));
const SAVE_EVERY_MS = 3 * 60 * 1000;
// AI と試合数の設定（docs/select.md の測定で決めた値）。変えたら保存済みの表は作り直しになる
const AI = { iters: Number(arg('iters', '100')), n0: Number(arg('n0', '4')), levels: arg('levels', '16,32').split(',').filter(Boolean).map(Number) };
// 保存先（確かめ用に別の場所へ書ける）
const OUT = arg('out', 'data/precomputed');
const deadline = Date.now() + MINUTES * 60 * 1000;

const PS = loadShowdown();
const validator = PS.TeamValidator.get(FORMAT);
const toID = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const plain = plainSet;

// 対象のパーティ：--party で1つ、なければ data/parties/ のうち precompute が true のもの
const partyFiles = arg('party', '') ? [arg('party', '')] : (existsSync('data/parties') ? readdirSync('data/parties').filter(f => f.endsWith('.json')).map(f => `data/parties/${f}`) : []);
const parties = partyFiles.map(f => JSON.parse(readFileSync(f, 'utf8'))).filter((p: any) => arg('party', '') || p.precompute);
const valid = (mons: any[]) => !validator.validateTeam(mons.map((m: any) => ({ ...m, name: '', level: 50, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 } })));
const rankFilter = arg('ranks', '') ? new Set(arg('ranks', '').split(',').map(Number)) : null;
// 今のシーズンの上位構築（data/season/current.json）
const seasonCfg = JSON.parse(readFileSync('data/season/current.json', 'utf8'));
const teams = JSON.parse(readFileSync(seasonCfg.teams, 'utf8'))
  .filter((t: any) => (!rankFilter || rankFilter.has(t.rank)) && valid(t.mons))
  .sort((a: any, b: any) => a.rank - b.rank);
// 仕事の並び：順位の高い構築から、パーティを順に。分担は番号の余りで分ける
const items: { party: any; team: any }[] = [];
for (const team of teams) for (const party of parties) items.push({ party, team });
const mine = items.filter((_, i) => i % SHARDS === SHARD);
console.log(`対象：パーティ ${parties.length}、構築 ${teams.length}、この分担の仕事 ${mine.length}、手伝い ${THREADS}、${MINUTES}分で区切る`);

interface Saved { party: string; partyKey: string; team: { rank: number; season: string; species: string[] }; ai: typeof AI; n: number[]; w: number[]; level: number; done: boolean; games: number; seconds: number; solution?: any; updatedAt: string }
// パーティの中身（6体の型）が同じかどうかの目印。名前や印を変えただけでは作り直さない
const partyKey = (party: any) => keyOf(party.mons);
// 表のファイル：M-7 は <順位>.json（最初に作った形のまま）、ほかのシーズンは m<番号>-<順位>.json。前のシーズンの表は残す
const fileOf = (party: any, team: any) => `${OUT}/${party.id}/${team.season === 'M-7' ? '' : `${String(team.season).toLowerCase().replace('-', '')}-`}${team.rank}.json`;
function load(party: any, team: any): Saved {
  const f = fileOf(party, team);
  const fresh: Saved = { party: party.id, partyKey: partyKey(party), team: { rank: team.rank, season: team.season, species: team.mons.map((m: any) => m.species) }, ai: AI, ...emptyStats(), level: 0, done: false, games: 0, seconds: 0, updatedAt: '' };
  if (!existsSync(f)) return fresh;
  const s: Saved = JSON.parse(readFileSync(f, 'utf8'));
  // パーティを直した、または AI の設定を変えたときは作り直す
  if (s.partyKey !== partyKey(party) || JSON.stringify(s.ai) !== JSON.stringify(AI)) { console.log(`作り直し：${f}（パーティか AI の設定が変わった）`); return fresh; }
  return s;
}
// こちらが選べる行：メガストーンを持つポケモンがちょうど1匹の組だけ（いなければ全部）。src/select/table.ts の allowedRows
const rowsOf = (party: any) => allowedRows(i => !!PS.Dex.forFormat(FORMAT).items.get(party.mons[i]?.item ?? '').megaStone);
function save(s: Saved, party: any, team: any) {
  mkdirSync(`${OUT}/${party.id}`, { recursive: true });
  const st: TableStats = { n: s.n, w: s.w };
  const rows = rowsOf(party);
  if ((rows ?? [...Array(SIZE).keys()]).every(r => s.n.slice(r * SIZE, r * SIZE + SIZE).every(x => x > 0))) {
    const sol = solveTable(st, undefined, 0.01, rows);
    const top = (p: number[]) => p.map((x, i) => [i, Math.round(x * 1e4) / 1e4]).filter(([, x]) => x > 0);
    // rule：こちらの選べる行の決まり（mega1：メガストーンを持つポケモンがちょうど1匹の組だけ、all：全部）
    s.solution = { value: Math.round(sol.value * 1e4) / 1e4, row: top(sol.row), col: top(sol.col), rule: rows ? 'mega1' : 'all' };
  }
  s.updatedAt = new Date().toISOString();
  writeFileSync(fileOf(party, team), JSON.stringify(s));
}

const workers: Worker[] = [];
const idle: Worker[] = [];
const ready = Array.from({ length: THREADS }, () => new Promise<void>(res => {
  const w = new Worker(new URL('./precompute-worker.ts', import.meta.url), { execArgv: ['--import', 'tsx'] });
  w.once('message', () => { idle.push(w); res(); });
  workers.push(w);
}));
await Promise.all(ready);

let totalGames = 0;
for (const { party, team } of mine) {
  if (Date.now() > deadline) break;
  const s = load(party, team);
  // 選べる行の決まりを後から変えたとき（2026-11-28、メガ1匹の組だけ）に、保存した「終わり」の表も、決まりに合わせて解き直し、足りないマスがあれば続ける
  if (s.done) { const w = nextWork(s, AI.n0, AI.levels, undefined, rowsOf(party)); if (w.done) { if (s.solution && !s.solution.rule) { save(s, party, team); } continue; } s.done = false; }
  const label = `${party.name ?? party.id} 対 ${team.rank}位`;
  const ours = party.mons.map(plain), theirs = team.mons.map(plain);
  let tMark = Date.now();
  const addTime = () => { s.seconds += (Date.now() - tMark) / 1000; tMark = Date.now(); };
  let lastSave = Date.now(), gamesHere = 0;
  console.log(`始める：${label}（保存済みの試合 ${s.games}）`);
  while (Date.now() < deadline) {
    const work = nextWork(s, AI.n0, AI.levels, undefined, rowsOf(party));
    s.level = work.level;
    if (work.done) { s.done = true; break; }
    // 足りない試合を、マスの番号の順に並べて手伝いに配る。試合の種は「マスと、そのマスの何試合目か」で決める
    const jobs: { k: number; g: number }[] = [];
    for (const [k, need] of work.need) for (let i = 0; i < need; i++) jobs.push({ k, g: s.n[k] + i });
    await new Promise<void>(resolve => {
      let next = 0, running = 0;
      const pump = () => {
        while (idle.length && next < jobs.length && Date.now() < deadline) {
          const { k, g } = jobs[next++];
          const w = idle.pop()!;
          running++;
          w.once('message', (m: any) => {
            running--; idle.push(w);
            if (m.error) console.log(`試合のエラー：マス ${m.r},${m.c}：${m.error}`);
            else { const kk = m.r * SIZE + m.c; s.n[kk]++; s.w[kk] += m.v; s.games++; gamesHere++; totalGames++; }
            if (Date.now() - lastSave > SAVE_EVERY_MS) { addTime(); save(s, party, team); lastSave = Date.now(); console.log(`途中の保存：${label} 段階 ${s.level}、試合 ${s.games}`); }
            if ((next >= jobs.length || Date.now() >= deadline) && running === 0) resolve(); else pump();
          });
          w.postMessage({ id: next, ours, theirs, r: Math.floor(k / SIZE), c: k % SIZE, iters: AI.iters, seed: (team.rank * 7919 + k * 104729 + g * 15485863 + (seasonCfg.seasonNumber === 7 ? 0 : seasonCfg.seasonNumber * 2654435761) + 1) >>> 0 });
        }
        if (running === 0) resolve();
      };
      pump();
    });
  }
  addTime();
  save(s, party, team);
  console.log(`${s.done ? '終わり' : '区切り'}：${label} 段階 ${s.level}、試合 ${s.games}（今回 ${gamesHere}）、勝率 ${s.solution?.value ?? '-'}`);
}
for (const w of workers) await w.terminate();
console.log(`今回の試合 ${totalGames}`);
