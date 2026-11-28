// 対戦の流れの確かめ：本当の対戦（Showdown）を決着まで打ち、毎ターン・毎回の死に出しの後に、記録係の状態が本当と一致するかを見る。
// 画面と同じ入力の流れにする：
//  - こちらが倒れたら、ターンは「倒れたまま（交代先はまだ）」で記録し、交代先は死に出し（replace）で記録する
//  - 相手だけが倒れたら、相手の交代先はターンの入力に入れる（画面ではターンの終わりに見える）
//  - 倒れた後の交代先は無作為に選ぶ（番号の若い体とは限らない）。場から下がった相手の体の HP% も入れる
// 見るもの：場の体（両方）、こちらの3体の HP、相手の見えた体の HP% と倒れたか、死に出しの場面の判定、決着の判定
// 使い方：npx tsx tools/battle/flow-check.ts [試合数=20] [種=1]
import { readFileSync } from 'node:fs';
import { loadShowdown, FORMAT } from '../showdown/load.ts';
import { makeRunner } from '../../src/engine/runner.ts';
import { makeAnalyzer } from '../../src/battle/analyze.ts';
import { sideTurnInput, revealFoe, type SideView } from '../../src/learn/viewer.ts';
import { shownPercent } from '../../src/infer/calc.ts';
import type { Action, Position, StatusID } from '../../src/engine/position.ts';

const GAMES = Number(process.argv[2] ?? 20), SEED = Number(process.argv[3] ?? 1);
const PS = loadShowdown(); const dex = PS.Dex.forFormat(FORMAT); const Runner = makeRunner(PS, FORMAT);
const priors = JSON.parse(readFileSync('data/priors/sets.json', 'utf8'));
const teams = JSON.parse(readFileSync('data/seed/teams_m7.json', 'utf8'));
const selections = JSON.parse(readFileSync('data/seed/selections_m7.json', 'utf8'));
const party = JSON.parse(readFileSync('test/fixtures/party-team2-screen.json', 'utf8'));
const Analyzer = makeAnalyzer(PS, FORMAT, priors, teams, selections);
const validator = PS.TeamValidator.get(FORMAT);
const okTeams = teams.filter((t: any) => !validator.validateTeam(t.mons.map((m: any) => ({ ...m, name: '', level: 50, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 } }))));
const toID = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
let st = SEED * 4099 + 11; const rand = () => { st = (st * 16807) % 2147483647; return st / 2147483647; };
const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
const pick3 = () => [0, 1, 2, 3, 4, 5].sort(() => rand() - 0.5).slice(0, 3);
const setOf = (m: any) => ({ species: m.species, item: toID(m.item), ability: toID(m.ability), nature: m.nature, evs: m.evs, moves: m.moves.map(toID) });
const base = (sp: string) => dex.species.get(sp).baseSpecies;

const bad: Record<string, number> = {}; const samples: string[] = [];
const note = (kind: string, msg: string) => { bad[kind] = (bad[kind] ?? 0) + 1; if (samples.length < 40) samples.push(`${kind}：${msg}`); };
let steps = 0, replaces = 0, ends = 0, games = 0;
for (let g = 0; g < GAMES; g++) {
  const team: any = pick(okTeams);
  const ourIdx = pick3(), oppIdx = pick3();
  const ours = ourIdx.map(i => setOf(party[i])), oppSets = oppIdx.map(i => setOf(team.mons[i]));
  const oppSpecies = team.mons.map((m: any) => dex.species.get(m.species).name);
  const pos: Position = { sides: [
    { mons: ours.map(s => ({ set: s, hp: 999, status: '' as StatusID })), active: 0 },
    { mons: oppSets.map(s => ({ set: s, hp: 999, status: '' as StatusID })), active: 0 },
  ] };
  const truth = new Runner(pos, g + 1, true); const b = truth.battle;
  const an = new Analyzer({ ours, ourLead: 0, oppSpecies, ourTeamJa: party.map((m: any) => m.jp) });
  const view: SideView = { side: 0, mySets: ours, foeSpecies: oppSpecies, foeIdx: oppIdx };
  const r0 = revealFoe(dex, b.log, 0, oppSpecies[oppIdx[0]]);
  an.start({ oppLead: oppIdx[0], oppAbility: r0.ability, oppItem: r0.item });
  games++;
  const ourHpsTruth = () => ours.map(o => b.sides[0].pokemon.find((p: any) => p.baseSpecies.baseSpecies === base(o.species)).hp);
  const oppIdxOf = (p: any) => oppSpecies.findIndex((n: string) => base(n) === p.baseSpecies.baseSpecies);
  const compare = (where: string) => {
    const us = an.pos.sides[0];
    const ta = b.sides[0].active[0], tIdx = ours.findIndex(o => base(o.species) === ta.baseSpecies.baseSpecies);
    if (us.active !== tIdx) note('こちらの場の体', `${where} 記録係 ${us.active} ／ 本当 ${tIdx}`);
    const th = ourHpsTruth(), ah = us.mons.map(m => m.hp);
    if (JSON.stringify(th) !== JSON.stringify(ah)) note('こちらの HP', `${where} 記録係 ${JSON.stringify(ah)} ／ 本当 ${JSON.stringify(th)}`);
    const oa = an.oppOrder[an.pos.sides[1].active], toa = oppIdxOf(b.sides[1].active[0]);
    if (oa !== toa) note('相手の場の体', `${where} 記録係 ${oppSpecies[oa]} ／ 本当 ${oppSpecies[toa]}`);
    for (const p of b.sides[1].pokemon) {
      const i = oppIdxOf(p); if (!an.opp[i].seen) continue;
      const pct = shownPercent(p.hp, p.maxhp);
      if (an.opp[i].hpPct !== pct) note('相手の HP%', `${where} ${oppSpecies[i]} 記録係 ${an.opp[i].hpPct} ／ 本当 ${pct}`);
      if (!!an.opp[i].fainted !== (p.hp <= 0)) note('相手が倒れたか', `${where} ${oppSpecies[i]} 記録係 ${an.opp[i].fainted} ／ 本当 ${p.hp <= 0}`);
    }
  };
  for (let t = 0; t < 80 && !b.ended; t++) {
    const l0 = truth.legalActions(0), l1 = truth.legalActions(1);
    const foeBefore = b.sides[1].active[0];
    const from = b.log.length, turnBefore = b.turn;
    let a0: Action | null = null, a1: Action | null = null;
    for (let tries = 0; tries < 8; tries++) {
      a0 = l0.length ? pick(l0) : null; a1 = l1.length ? pick(l1) : null;
      for (const sd of b.sides) if (sd.activeRequest && !sd.activeRequest.wait) sd.choice = { cantUndo: false, error: '', actions: [], forcedSwitchesLeft: 0, forcedPassesLeft: 0, switchIns: new Set(), zMove: false, mega: false, ultra: false, dynamax: false, terastallize: false };
      // 倒れた後の交代は自動で選ばない（maxSteps 0）
      truth.play(a0, a1, 0);
      if (b.turn !== turnBefore || b.ended || b.requestState === 'switch') break;
    }
    if (b.turn === turnBefore && !b.ended && b.requestState !== 'switch') break;
    // とんぼがえり等で、ターンの途中に交代先を選ぶ要求が出ることがある：無作為に選んで、ターンの終わりまで進める
    let guard = 0;
    while (!b.ended && b.requestState === 'switch' && guard++ < 6) {
      const ourNeeds = !!b.sides[0].activeRequest?.forceSwitch, oppNeeds = !!b.sides[1].activeRequest?.forceSwitch;
      const ourFainted = b.sides[0].active[0].fainted;
      // こちらの場の体が倒れた → ターンは倒れたまま記録して、死に出しで交代先を入れる（ここで止める）
      if (ourNeeds && ourFainted) break;
      // 相手の場の体が倒れた（こちらは倒れていない）→ 相手は交代先を出す（画面ではターンの終わりに見える）
      if (oppNeeds && !ourNeeds && b.sides[1].active[0].fainted) { b.choose('p2', truth.choiceString(1, pick(truth.legalActions(1)))); continue; }
      // とんぼがえり等のターンの途中の交代
      if (ourNeeds) b.choose('p1', truth.choiceString(0, pick(truth.legalActions(0))));
      if (oppNeeds) b.choose('p2', truth.choiceString(1, pick(truth.legalActions(1))));
    }
    const lines = (b.log as string[]).slice(from);
    const input = sideTurnInput(dex, b, view, lines, a0, a1, foeBefore);
    if (process.env.DUMP === `${g}:${t}`) { console.log(lines.filter(l => /switch|drag|faint|move|damage|-heal/.test(l)).join('\n')); console.log('入力', JSON.stringify({ ours: input.ours, opp: input.opp, after: input.after })); }
    an.record(input);
    steps++;
    compare(`試合${g} ターン${t}`);
    if (b.ended) {
      ends++;
      const ourAlive = an.pos.sides[0].mons.filter(m => m.hp > 0).length, oppFainted = an.opp.filter(o => o.fainted).length;
      const endSeen = ourAlive === 0 || oppFainted >= 3;
      if (!endSeen) note('決着の判定', `試合${g} 本当は決着、記録係：こちらの残り ${ourAlive}、相手の倒れた数 ${oppFainted}`);
      if (an.pendingSides().length) note('決着の判定', `試合${g} 決着したのに死に出しの場面と判定 ${an.pendingSides()}`);
      break;
    }
    // 死に出し
    const pend = an.pendingSides();
    const truthPend: number[] = [];
    if (b.requestState === 'switch' && b.sides[0].activeRequest?.forceSwitch) truthPend.push(0);
    if (b.requestState === 'switch' && b.sides[1].activeRequest?.forceSwitch) truthPend.push(1);
    if (JSON.stringify(pend) !== JSON.stringify(truthPend)) note('死に出しの場面の判定', `試合${g} ターン${t} 記録係 ${JSON.stringify(pend)} ／ 本当 ${JSON.stringify(truthPend)}`);
    if (truthPend.length) {
      const from2 = b.log.length;
      const c0 = truthPend.includes(0) ? pick(truth.legalActions(0)) as any : null, c1 = truthPend.includes(1) ? pick(truth.legalActions(1)) as any : null;
      if (c0) b.choose('p1', truth.choiceString(0, c0));
      if (c1) b.choose('p2', truth.choiceString(1, c1));
      const lines2 = (b.log as string[]).slice(from2);
      const oppTo = c1 ? oppIdxOf(b.sides[1].active[0]) : undefined;
      const rv = oppTo !== undefined ? revealFoe(dex, lines2, 0, oppSpecies[oppTo]) : { ability: undefined, item: undefined };
      an.replace({ ourTo: c0 ? c0.to : undefined, oppTo, ourHps: ourHpsTruth(), oppHpPct: oppTo !== undefined ? shownPercent(b.sides[1].active[0].hp, b.sides[1].active[0].maxhp) : undefined, oppAbility: rv.ability, oppItem: rv.item });
      replaces++;
      compare(`試合${g} ターン${t} 死に出しの後`);
      if (an.pendingSides().length) note('死に出しの場面の判定', `試合${g} ターン${t} 死に出しの後も ${an.pendingSides()}`);
    }
  }
}
console.log(`試合 ${games}、ターン ${steps}、死に出し ${replaces}、決着 ${ends}`);
console.log(Object.keys(bad).length ? `ずれ：${JSON.stringify(bad)}` : 'ずれ：なし');
for (const x of samples) console.log('  ' + x);
