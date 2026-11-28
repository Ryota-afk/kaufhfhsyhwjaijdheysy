// 選出の表の1マス：こちらの「3匹＋先発」と相手の「3匹＋先発」で、AIどうしを対戦させて勝ち負けを数える。
// どちらのAIも、同時手番の木探索（src/search/mcts.ts）を1手ごとに iters 回だけ回す。両者の型は分かっている前提で打つ。
import { search, legalChoices, step } from '../search/mcts.ts';

/** 6匹から3匹の選び方（20通り、番号の小さい順）。 */
export const TRIOS: number[][] = (() => {
  const out: number[][] = [];
  for (let a = 0; a < 6; a++) for (let b = a + 1; b < 6; b++) for (let c = b + 1; c < 6; c++) out.push([a, b, c]);
  return out;
})();

/** 行・列の番号（0〜59）＝ 3匹の番号×3 ＋ 先発がその3匹の何番目か。 */
export function pickOf(k: number): { trio: number[]; lead: number; order: number[] } {
  const trio = TRIOS[Math.floor(k / 3)], li = k % 3;
  return { trio, lead: trio[li], order: [trio[li], ...trio.filter((_, i) => i !== li)] };
}
export function indexOf(trio: number[], lead: number): number {
  const t = [...trio].sort((a, b) => a - b);
  const ti = TRIOS.findIndex(x => x[0] === t[0] && x[1] === t[1] && x[2] === t[2]);
  return ti * 3 + t.indexOf(lead);
}

export interface PlainSet { species: string; item: string; ability: string; nature: string; evs: any; moves: string[] }
const toShowdown = (m: PlainSet) => ({ name: '', species: m.species, item: m.item, ability: m.ability, nature: m.nature, evs: m.evs, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }, moves: m.moves, level: 50, gender: '' });

/**
 * 1試合を打つ。ours / theirs は6匹、rowK / colK は行・列の番号。戻り値：こちらの勝ち 1、負け 0、決着なし 0.5。
 * PS は速さの層を当てた Showdown、clone は速い複製。
 */
export function playCell(PS: any, FORMAT: string, clone: (b: any) => any, ours: PlainSet[], theirs: PlainSet[], rowK: number, colK: number, iters: number, seed: number): number {
  let st = (seed >>> 0) || 1;
  const rand = () => { st = (st * 1664525 + 1013904223) >>> 0; return st / 4294967296; };
  const b = new PS.Battle({ formatid: FORMAT, seed: [seed & 0xffff, (seed >>> 16) & 0xffff, 7, 11].join(',') });
  const a = pickOf(rowK), c = pickOf(colK);
  b.setPlayer('p1', { name: 'p1', team: PS.Teams.pack(a.order.map(i => toShowdown(ours[i]))) });
  b.setPlayer('p2', { name: 'p2', team: PS.Teams.pack(c.order.map(i => toShowdown(theirs[i]))) });
  b.choose('p1', 'team 123'); b.choose('p2', 'team 123');
  const choose = (si: 0 | 1) => {
    const side = b.sides[si], req = side.activeRequest;
    if (!req || req.wait) return '';
    if (req.forceSwitch) { const o = legalChoices(side); return o[Math.floor(rand() * o.length)]; }
    const r = search([b], clone, { timeMs: 1e9, maxIters: iters, rand });
    const list = si === 0 ? r.ours : r.theirs;
    return list[0]?.choice ?? legalChoices(side)[0];
  };
  for (let guard = 0; guard < 150 && !b.ended; guard++) step(b, choose(0), choose(1), rand);
  if (!b.ended || !b.winner) return 0.5;
  return b.winner === 'p1' ? 1 : 0;
}
