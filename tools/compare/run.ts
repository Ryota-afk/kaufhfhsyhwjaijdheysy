// 照合の本体：ランダムな盤面で、Showdown（速さの層なし）とエンジン（速さの層あり＋複製）を、同じ乱数の種で打ち比べる。
// 使い方：npm run compare -- [盤面の数=1000] [種の数=30] [ターン数=3] [盤面を作る種=1]
// 結果は docs/engine-compare.md に書く。
import { readFileSync, writeFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { loadShowdown, FORMAT, showdownCommit } from '../showdown/load.ts';
import { ShowdownRunner } from './showdown-adapter.ts';
import { genPosition, Rng } from './gen.ts';
import { runJob, type Job, type RunResult } from './play.ts';
import { compareDistributions, flatten } from './stats.ts';
import type { Action } from '../../src/engine/position.ts';

const [NPOS, NSEED, NTURN, GSEED] = [1000, 30, 3, 1].map((d, i) => Number(process.argv[2 + i] ?? d));
const PS = loadShowdown();
const dex = PS.Dex.forFormat(FORMAT);
const validator = PS.TeamValidator.get(FORMAT);
const allTeams = JSON.parse(readFileSync('data/seed/teams_m7.json', 'utf8'));
const teams = allTeams.filter((t: any) => !validator.validateTeam(t.mons.map((m: any) => ({ ...m, name: '', level: 50, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 } }))));

// 盤面と最初の行動を作る
const rng = new Rng(GSEED);
const jobs: Job[] = [];
let buildFail = 0;
const buildErrors = new Map<string, number>();
while (jobs.length < NPOS) {
  const pos = genPosition(rng, teams, dex);
  try {
    const r = new ShowdownRunner(pos, 1);
    const pick = (si: number): Action => {
      const l = r.legalActions(si);
      const moves = l.filter(a => a.kind === 'move');
      return (moves.length && rng.chance(0.75)) ? rng.pick(moves) : rng.pick(l);
    };
    const first: [Action, Action] = [pick(0), pick(1)];
    const seeds = Array.from({ length: NSEED }, (_, k) => 1000 * jobs.length + k + 1);
    jobs.push({ pos, first, seeds, turns: NTURN });
  } catch (e: any) {
    buildFail++;
    const k = String(e?.message ?? e).slice(0, 80);
    buildErrors.set(k, (buildErrors.get(k) ?? 0) + 1);
  }
}

// エンジン側（別スレッド）
const CHUNK = 20;
const worker = new Worker(new URL('./worker.ts', import.meta.url), { execArgv: ['--import', 'tsx'] });
const fastResults: RunResult[][] = [];
const fastDone = new Promise<void>(resolve => {
  let i = 0;
  const send = () => { if (i >= jobs.length) { resolve(); return; } worker.postMessage(jobs.slice(i, i + CHUNK)); i += CHUNK; };
  worker.on('message', (res: RunResult[][]) => { fastResults.push(...res); send(); });
  send();
});

// Showdown 側（このスレッド）。記録から、実際に出た技・持ち物・特性を数える
const used = { move: new Map<string, number>(), item: new Map<string, number>(), ability: new Map<string, number>() };
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
const collect = (r: ShowdownRunner) => {
  for (const line of r.battle.log as string[]) {
    let m = /^\|move\|[^|]*\|([^|]*)/.exec(line); if (m) bump(used.move, m[1]);
    for (const mm of line.matchAll(/\[from\] item: ([^|]*)/g)) bump(used.item, mm[1]);
    for (const mm of line.matchAll(/\[from\] ability: ([^|]*)/g)) bump(used.ability, mm[1]);
    m = /^\|-(?:enditem|item)\|[^|]*\|([^|]*)/.exec(line); if (m) bump(used.item, m[1]);
    m = /^\|-ability\|[^|]*\|([^|]*)/.exec(line); if (m) bump(used.ability, m[1]);
    m = /^\|-activate\|[^|]*\|(?:item|ability): ([^|]*)/.exec(line); if (m) bump(m[0].includes('item:') ? used.item : used.ability, m[1]);
  }
};
const t0 = Date.now();
const refResults: RunResult[][] = [];
for (const [i, job] of jobs.entries()) {
  refResults.push(runJob(job, undefined, collect));
  if ((i + 1) % 200 === 0) console.log(`Showdown 側 ${i + 1}/${jobs.length}（${((Date.now() - t0) / 1000).toFixed(0)}秒）`);
}
await fastDone;
await worker.terminate();

// 比べる
let runs = 0, same = 0, errBoth = 0;
const mismatches: string[] = [];
const distDiffs: string[] = [];
const errors = new Map<string, number>();
let turnsPlayed = 0;
for (let i = 0; i < jobs.length; i++) {
  const A = refResults[i], B = fastResults[i];
  for (let k = 0; k < A.length; k++) {
    runs++;
    const a = A[k], b = B[k];
    turnsPlayed += 1 + a.moves.length;
    if (a.error || b.error) {
      if (a.error === b.error) { errBoth++; errors.set(a.error!, (errors.get(a.error!) ?? 0) + 1); }
      else mismatches.push(`盤面${i} 種${jobs[i].seeds[k]}：エラーが片方だけ（Showdown: ${a.error ?? 'なし'} ／ エンジン: ${b.error ?? 'なし'}）`);
      continue;
    }
    if (JSON.stringify(a.outcome) === JSON.stringify(b.outcome)) { same++; continue; }
    const fa = flatten(a.outcome!), fb = flatten(b.outcome!);
    const keys = Object.keys(fa).filter(x => fa[x] !== fb[x]);
    mismatches.push(`盤面${i} 種${jobs[i].seeds[k]}：${keys.slice(0, 4).map(x => `${x} Showdown=${fa[x]} エンジン=${fb[x]}`).join('、')}`);
  }
  const okA = A.filter(x => x.outcome).map(x => x.outcome!), okB = B.filter(x => x.outcome).map(x => x.outcome!);
  if (okA.length >= 10 && okB.length >= 10) for (const d of compareDistributions(okA, okB)) distDiffs.push(`盤面${i}：${d.key}（p=${d.p.toExponential(2)}）`);
}

const seedMoves = new Set<string>(), seedItems = new Set<string>(), seedAbilities = new Set<string>();
for (const t of teams) for (const m of t.mons) {
  m.moves.forEach((x: string) => seedMoves.add(dex.moves.get(x).name));
  seedItems.add(dex.items.get(m.item).name); seedAbilities.add(dex.abilities.get(m.ability).name);
}
const cover = (used: Map<string, number>, all: Set<string>) => [...all].filter(x => used.has(x)).length;
const notUsed = [...seedMoves].filter(x => !used.move.has(x)).sort();

const L: string[] = [];
L.push('# エンジンと Showdown の照合結果', '');
L.push(`- 実行日：${new Date().toISOString().slice(0, 10)}`);
L.push(`- 基準：Pokémon Showdown コミット ${showdownCommit()}、形式 ${FORMAT}（速さの層なし）`);
L.push('- 比べる相手：エンジン（同じ Showdown に速さの層を当て、盤面を作った後に速い複製をして、複製の上で打つ）');
L.push(`- 盤面：${jobs.length} 通り（ランダムに作成。作成に失敗して作り直した盤面：${buildFail}）。上位構築 ${teams.length} 件（Showdown の検査を通るもの）から3匹ずつ`);
L.push(`- 1つの盤面につき乱数の種 ${NSEED} 通り × 最大 ${NTURN} ターン（2ターン目以降の行動は種から決まる番号で選ぶ）。打った回数：${runs}、ターン数：${turnsPlayed}`);
L.push(`- 時間：${((Date.now() - t0) / 1000).toFixed(0)} 秒`, '');
L.push('## 結果', '');
L.push(`- 種ごとに結果が完全に一致：${same} / ${runs - errBoth}（両方で同じエラーになった ${errBoth} 回を除く）`);
L.push(`- 一致しなかった回数：${mismatches.length}`);
L.push(`- 割合の比較（項目ごとのカイ二乗検定、p < 0.0001）で差が出た項目：${distDiffs.length}`);
L.push('', '## ずれの一覧', '');
if (!mismatches.length && !distDiffs.length) L.push('ずれは見つかりませんでした。');
for (const x of mismatches.slice(0, 100)) L.push(`- ${x}`);
if (mismatches.length > 100) L.push(`- ほか ${mismatches.length - 100} 件`);
for (const x of distDiffs.slice(0, 50)) L.push(`- 割合：${x}`);
L.push('', '## 両方で同じエラーになったもの', '');
if (!errors.size) L.push('なし');
for (const [k, v] of errors) L.push(`- ${v} 回：${k}`);
L.push('', '## 照合で実際に出た技・持ち物・特性', '');
L.push(`- 技：上位構築の ${seedMoves.size} 種のうち ${cover(used.move, seedMoves)} 種が出た（全部で ${used.move.size} 種）`);
L.push(`- 持ち物：上位構築の ${seedItems.size} 種のうち ${cover(used.item, seedItems)} 種が、記録に名前つきで出た（効果が出たもの）`);
L.push(`- 特性：上位構築の ${seedAbilities.size} 種のうち ${cover(used.ability, seedAbilities)} 種が、記録に名前つきで出た`);
L.push(`- 出なかった技：${notUsed.join('、') || 'なし'}`);
L.push('', '## これまでに見つけて直したずれ', '');
L.push('- 2026-11-26：処理先の一覧が、関数でない処理（例：シェルアーマー・カブトアーマーの `onCriticalHit: false`）を拾っていなかった。急所を防げず、1000盤面×30種のうち24回ずれた。値があれば拾うように直し、以後のずれは0。');
L.push('- 2026-11-26：盤面の複製で、ポケモンが自分を指す関数（HP表示用、getHealth）が元のポケモンを指したままだった。選べる行動の一覧の作成にも使われるため、複製先に付け直した。');
L.push('', '## 読み方', '');
L.push('エンジンは Showdown 本体に「速さの層」（記録を作らない、処理先の探し方を速くする、技データの写し方を速くする、盤面の速い複製）を当てたもの。');
L.push('速さの層は乱数の使い方を変えないので、同じ種なら結果は完全に一致するはずで、1回でも一致しなければ速さの層の誤り。');
L.push('割合の比較は、将来 Showdown とは別の実装を照合するときにも使える一般の方法として残している。');
L.push('持ち物・特性の数は、対戦の記録に名前つきで出たものだけを数えている。タイプ強化の持ち物（しんぴのしずく等）や、いのちのたまの威力の上がり方などは記録に名前が出ないので、効いていても数に入らない。');
L.push('照合の仕組みが働くことは、エンジン側にわざと誤り（まきびしを層の数によらず1/8）を入れて確かめた：150盤面×10種で117回の不一致と、割合の比較で1項目の差が出た（COMPARE_INJECT=spikes）。');
writeFileSync('docs/engine-compare.md', L.join('\n') + '\n');
console.log(L.slice(0, 16).join('\n'));
if (mismatches.length || distDiffs.length) process.exitCode = 1;
