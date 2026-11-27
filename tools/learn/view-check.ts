// src/learn/viewer.ts の確かめ：無作為に打つ試合で、p1・p2 の両方の側に、それぞれ見えることだけを記録係に入れ、
// 相手の本当の型が推定から消えないか、記録係が止まらないかを見る。
// 使い方：npx tsx tools/learn/view-check.ts [試合数=20] [種=1]
import { readFileSync } from 'node:fs';
import { loadShowdown, FORMAT } from '../showdown/load.ts';
import { makeRunner } from '../../src/engine/runner.ts';
import { makeAnalyzer } from '../../src/battle/analyze.ts';
import { sideTurnInput, revealFoe, type SideView } from '../../src/learn/viewer.ts';
import type { Action, Position, StatusID } from '../../src/engine/position.ts';

const GAMES = Number(process.argv[2] ?? 20), SEED = Number(process.argv[3] ?? 1);
const PS = loadShowdown(); const dex = PS.Dex.forFormat(FORMAT); const Runner = makeRunner(PS, FORMAT);
const priors = JSON.parse(readFileSync('data/priors/sets.json', 'utf8'));
const teams = JSON.parse(readFileSync('data/seed/teams_m7.json', 'utf8'));
const selections = JSON.parse(readFileSync('data/seed/selections_m7.json', 'utf8'));
const Analyzer = makeAnalyzer(PS, FORMAT, priors, teams, selections);
const validator = PS.TeamValidator.get(FORMAT);
const okTeams = teams.filter((t: any) => !validator.validateTeam(t.mons.map((m: any) => ({ ...m, name: '', level: 50, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 } }))));
const toID = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
let st = SEED * 977 + 5; const rand = () => { st = (st * 16807) % 2147483647; return st / 2147483647; };
const pick3 = () => [0, 1, 2, 3, 4, 5].sort(() => rand() - 0.5).slice(0, 3);
const setOf = (m: any) => ({ species: m.species, item: toID(m.item), ability: toID(m.ability), nature: m.nature, evs: m.evs, moves: m.moves.map(toID) });
let lost = [0, 0], errors = [0, 0], turns = 0;
for (let g = 0; g < GAMES; g++) {
  const T = [okTeams[Math.floor(rand() * okTeams.length)], okTeams[Math.floor(rand() * okTeams.length)]];
  const idx = [pick3(), pick3()];
  const sets = [0, 1].map(s => idx[s].map(i => setOf(T[s].mons[i])));
  const pos: Position = { sides: [0, 1].map(s => ({ mons: sets[s].map(x => ({ set: x, hp: 999, status: '' as StatusID })), active: 0 })) as any };
  const truth = new Runner(pos, g + 1, true); const b = truth.battle;
  const views: SideView[] = [0, 1].map(s => ({ side: s as 0 | 1, mySets: sets[s], foeSpecies: T[1 - s].mons.map((m: any) => dex.species.get(m.species).name), foeIdx: idx[1 - s] }));
  const ans = [0, 1].map(s => new Analyzer({ ours: sets[s], ourLead: 0, oppSpecies: views[s].foeSpecies, ourTeamJa: T[s].mons.map((m: any) => m.jp) }));
  [0, 1].forEach(s => { const r = revealFoe(dex, b.log, s as 0 | 1, sets[1 - s][0].species); ans[s].start({ oppLead: idx[1 - s][0], oppAbility: r.ability, oppItem: r.item }); });
  for (let t = 0; t < 40 && !b.ended; t++) {
    const l = [truth.legalActions(0), truth.legalActions(1)];
    const foeBefore = [b.sides[1].active[0], b.sides[0].active[0]];
    const from = b.log.length, turnBefore = b.turn;
    let a: (Action | null)[] = [null, null];
    for (let tries = 0; tries < 8 && b.turn === turnBefore && !b.ended; tries++) {
      a = l.map(x => x.length ? x[Math.floor(rand() * x.length)] : null);
      for (const sd of b.sides) if (sd.activeRequest && !sd.activeRequest.wait) sd.choice = { cantUndo: false, error: '', actions: [], forcedSwitchesLeft: 0, forcedPassesLeft: 0, switchIns: new Set(), zMove: false, mega: false, ultra: false, dynamax: false, terastallize: false };
      truth.play(a[0], a[1]);
    }
    if (b.turn === turnBefore && !b.ended) break;
    if (b.ended) break;
    const lines = (b.log as string[]).slice(from);
    turns++;
    for (const s of [0, 1]) {
      try { ans[s].record(sideTurnInput(dex, b, views[s], lines, a[s], a[1 - s], foeBefore[s])); } catch (e: any) { errors[s]++; console.log(`試合${g} 側${s + 1}：${e.message}`); }
      for (const [k, i] of idx[1 - s].entries()) {
        if (!ans[s].opp[i].seen) continue;
        const ts = T[1 - s].mons[i];
        const post = ans[s].sets[i].posterior();
        const ci = ans[s].sets[i].cands.findIndex((c: any) => !c.generic && toID(c.item) === toID(ts.item) && toID(c.nature) === toID(ts.nature) && JSON.stringify(c.evs) === JSON.stringify(ts.evs) && c.moves.every((m: string) => ts.moves.map(toID).includes(toID(m))));
        if (!post || ci < 0 || post[ci] <= 0) { lost[s]++; if (lost[s] <= 3) { const c = ci >= 0 ? ans[s].sets[i].cands[ci] : null; console.log(`試合${g} ターン${t} 側${s + 1}：${ts.species} の本当の型が消えた（${k}）：` + (c ? ans[s].sets[i].clues.map((cl: any) => `${cl.label}=${cl.like(c).toFixed(3)}`).join(' / ') : '候補にない')); } }
      }
    }
  }
}
console.log(`試合 ${GAMES}、ターン ${turns}。本当の型が消えた回数：p1側 ${lost[0]}、p2側 ${lost[1]}。記録係のエラー：p1側 ${errors[0]}、p2側 ${errors[1]}`);
