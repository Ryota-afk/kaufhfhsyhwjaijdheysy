// AIどうしの対戦で強さを比べる。
// 使い方：npx tsx tools/search/arena.ts A B 試合数 探索の回数 [種=1]
//   A・B：random（ランダム）、greedy（威力×相性×タイプ一致が最大の技）、mcts（探索。相手の本当の型を知っている前提）
// 結果：A の勝率と、95%の幅（±2×標準誤差）。.build/arena-A-B-回数.json にも書く。
// 先手・後手の差が出ないよう、A は試合の半分で p1、残りで p2。チームは上位構築から無作為、選出も無作為（3体と先発）。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { loadShowdown, FORMAT } from '../showdown/load.ts';
import { applySpeedLayer } from '../../src/engine/fast.ts';
import { makeCloner } from '../../src/engine/clone.ts';
import { search, legalChoices, step } from '../../src/search/mcts.ts';

const [A, B] = [process.argv[2] ?? 'mcts', process.argv[3] ?? 'random'];
const GAMES = Number(process.argv[4] ?? 100), ITERS = Number(process.argv[5] ?? 500), SEED = Number(process.argv[6] ?? 1);
const PS = loadShowdown();
applySpeedLayer(PS, PS.Battle, FORMAT);
const dex = PS.Dex.forFormat(FORMAT);
const clone = makeCloner(dex, PS.Pokemon);
const validator = PS.TeamValidator.get(FORMAT);
const teams = JSON.parse(readFileSync('data/seed/teams_m7.json', 'utf8')).filter((t: any) => !validator.validateTeam(t.mons.map((m: any) => ({ ...m, name: '', level: 50, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 } }))));
let st = SEED * 7919 + 1; const rand = () => { st = (st * 16807) % 2147483647; return st / 2147483647; };
const toSets = (t: any) => t.mons.map((m: any) => ({ name: '', species: m.species, item: m.item, ability: m.ability, nature: m.nature, evs: m.evs, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }, moves: m.moves, level: 50, gender: '' }));

function greedy(b: any, si: number): string {
  const side = b.sides[si], opts = legalChoices(side);
  const me = side.active[0], foe = b.sides[1 - si].active[0];
  if (!me || !foe || side.activeRequest?.forceSwitch) return opts[Math.floor(rand() * opts.length)];
  let best = '', bestV = -1;
  for (const o of opts) {
    if (!o.startsWith('move') || o.endsWith('mega')) continue;
    const k = Number(o.split(' ')[1]) - 1;
    const mv = dex.moves.get(me.moveSlots[k]?.id);
    if (!mv || mv.category === 'Status') continue;
    const eff = foe.runImmunity(mv) ? 2 ** dex.getEffectiveness(mv, foe) : 0;
    const v = (mv.basePower || 60) * eff * (me.hasType(mv.type) ? 1.5 : 1) * ((mv.accuracy === true ? 100 : mv.accuracy) / 100);
    if (v > bestV) { bestV = v; best = o; }
  }
  return best || opts[Math.floor(rand() * opts.length)];
}
function mcts(b: any, si: number, iters = ITERS): string {
  const side = b.sides[si];
  if (side.activeRequest?.forceSwitch) { const o = legalChoices(side); return o[Math.floor(rand() * o.length)]; }
  const r = search([b], clone, { timeMs: 1e9, maxIters: iters, rand });
  const list = si === 0 ? r.ours : r.theirs;
  return list[0]?.choice ?? legalChoices(side)[0];
}
const agents: Record<string, (b: any, si: number) => string> = { random: (b, si) => { const o = legalChoices(b.sides[si]); return o[Math.floor(rand() * o.length)]; }, greedy, mcts };
// 「mcts:回数」で、探索の回数を変えたAIどうしを比べられる
for (const name of [A, B]) { const m = /^mcts:(\d+)$/.exec(name); if (m) agents[name] = (b, si) => mcts(b, si, Number(m[1])); }

let winsA = 0, draws = 0, turns = 0;
const t0 = Date.now();
for (let g = 0; g < GAMES; g++) {
  const aIsP1 = g % 2 === 0;
  const b = new PS.Battle({ formatid: FORMAT, seed: [g + 1, SEED, 3, 4].join(',') });
  b.setPlayer('p1', { name: 'p1', team: PS.Teams.pack(toSets(teams[Math.floor(rand() * teams.length)])) });
  b.setPlayer('p2', { name: 'p2', team: PS.Teams.pack(toSets(teams[Math.floor(rand() * teams.length)])) });
  for (const id of ['p1', 'p2']) { const perm = [1, 2, 3, 4, 5, 6].sort(() => rand() - 0.5).slice(0, 3); b.choose(id, `team ${perm.join('')}`); }
  const who = [aIsP1 ? agents[A] : agents[B], aIsP1 ? agents[B] : agents[A]];
  let guard = 0;
  while (!b.ended && guard++ < 150) {
    const c = [0, 1].map(si => { const req = b.sides[si].activeRequest; return !req || req.wait ? '' : who[si](b, si); });
    step(b, c[0], c[1], rand);
  }
  turns += b.turn;
  if (!b.ended || !b.winner) draws++;
  else if ((b.winner === 'p1') === aIsP1) winsA++;
  if ((g + 1) % 20 === 0) console.log(`${g + 1}試合：${A} の勝ち ${winsA}（引き分け ${draws}）、${((Date.now() - t0) / 1000).toFixed(0)}秒`);
}
const p = (winsA + draws / 2) / GAMES, se = Math.sqrt(p * (1 - p) / GAMES);
const res = { A, B, games: GAMES, iters: ITERS, winsA, draws, winRateA: p, se, avgTurns: turns / GAMES, seconds: (Date.now() - t0) / 1000 };
mkdirSync('.build', { recursive: true });
writeFileSync(`.build/arena-${A}-${B}-${ITERS}.json`.replace(/:/g, '_'), JSON.stringify(res, null, 1));
console.log(`${A} 対 ${B}（${GAMES}試合、探索${ITERS}回）：${A} の勝率 ${p.toFixed(3)} ± ${(2 * se).toFixed(3)}（引き分けは半分で数える）、平均 ${(turns / GAMES).toFixed(1)} ターン`);
