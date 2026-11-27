// 行動の順番の計算（src/infer/calc.ts の oppFirstProb）が、Showdown で実際に打った順番と合うかを確かめる。
// 確率が0か1の回は全部当たるか、1/2の回（同じ素早さ）は半分くらいか、を見る。
// 使い方：npx tsx tools/infer/order-check.ts [盤面の数=400] [種の数=6]
import { readFileSync } from 'node:fs';
import { loadShowdown, FORMAT } from '../showdown/load.ts';
import { ShowdownRunner } from '../compare/showdown-adapter.ts';
import { genPosition, Rng } from '../compare/gen.ts';
import { makeCalc } from '../../src/infer/calc.ts';

const [NPOS, NSEED] = [400, 6].map((d, i) => Number(process.argv[2 + i] ?? d));
const PS = loadShowdown();
const dex = PS.Dex.forFormat(FORMAT);
const calc = makeCalc(PS, FORMAT);
const validator = PS.TeamValidator.get(FORMAT);
const teams = JSON.parse(readFileSync('data/seed/teams_m7.json', 'utf8')).filter((t: any) => !validator.validateTeam(t.mons.map((m: any) => ({ ...m, name: '', level: 50, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 } }))));
const rng = new Rng(9);
let sure = 0, sureOk = 0, half = 0, halfFirst = 0, other = 0, otherSum = 0, otherFirst = 0, skipped = 0;
const bad: string[] = [];
for (let n = 0; n < NPOS; n++) {
  const pos = genPosition(rng, teams, dex);
  for (const s of pos.sides) { const a = s.mons[s.active]; if (a.hp <= 0) a.hp = 1; a.status = ''; delete a.vol; a.pp = undefined; }
  const k0 = rng.int(4), k1 = rng.int(4);
  const m0 = pos.sides[0].mons[pos.sides[0].active].set.moves[k0], m1 = pos.sides[1].mons[pos.sides[1].active].set.moves[k1];
  if (!m0 || !m1) { skipped++; continue; }
  const p = calc.oppFirstProb(JSON.parse(JSON.stringify(pos)), 0, m0, m1);
  for (let s = 1; s <= NSEED; s++) {
    let r; try { r = new ShowdownRunner(pos, s); } catch { skipped++; continue; }
    r.play({ kind: 'move', slot: k0 }, { kind: 'move', slot: k1 });
    const log: string[] = r.battle.log;
    const t = log.indexOf('|turn|1');
    const moves = log.slice(t).filter(l => l.startsWith('|move|p1a') || l.startsWith('|move|p2a') || l.startsWith('|cant|'));
    const first = moves.find(l => l.startsWith('|move|'));
    if (!first || moves.some(l => l.startsWith('|cant|')) || moves.filter(l => l.startsWith('|move|')).length < 2) { skipped++; continue; }
    const oppFirst = first.startsWith('|move|p2a');
    if (p === 0 || p === 1) { sure++; if ((p === 1) === oppFirst) sureOk++; else if (bad.length < 6) bad.push(`盤面${n} 種${s}：${m0} と ${m1}、計算 ${p}、実際 ${oppFirst ? '相手が先' : 'こちらが先'}`); }
    else if (p === 0.5) { half++; if (oppFirst) halfFirst++; }
    else { other++; otherSum += p; if (oppFirst) otherFirst++; }
  }
}
console.log(`確率0か1の回：${sureOk} / ${sure} が当たった`);
console.log(`確率1/2の回：${half} 回のうち相手が先 ${halfFirst} 回（${half ? (halfFirst / half).toFixed(3) : '-'}）`);
console.log(`それ以外（せんせいのツメ）：${other} 回、計算の平均 ${other ? (otherSum / other).toFixed(3) : '-'}、実際に相手が先 ${other ? (otherFirst / other).toFixed(3) : '-'}`);
console.log(`対象外 ${skipped} 回`);
bad.forEach(x => console.log('外れ', x));
process.exitCode = sureOk === sure ? 0 : 1;
