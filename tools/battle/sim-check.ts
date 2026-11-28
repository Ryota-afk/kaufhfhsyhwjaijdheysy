// 対戦の記録係（src/battle/analyze.ts）の通しの確かめ。
// Showdown で本当に対戦（こちら：利用者のチーム2から3体、相手：上位構築から3体）を打ち、毎ターン、画面に見えることだけを
// 記録係に入れていく。次を確かめる：
//  1. 相手の本当の型が、推定から消えない（手がかりで誤って消していない）
//  2. こちらのHPと場の体、相手のHPの%が合う
//  3. 仮の盤面8つが、Showdown で作れる
//  4. 探索が上位3手を返す
//  5. 再現が入力と合った割合
// 使い方：npx tsx tools/battle/sim-check.ts [試合数=30] [種=1]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { loadShowdown, FORMAT } from '../showdown/load.ts';
import { makeRunner } from '../../src/engine/runner.ts';
import { makeCloner } from '../../src/engine/clone.ts';
import { makeAnalyzer, type TurnInput } from '../../src/battle/analyze.ts';
import { shownPercent } from '../../src/infer/calc.ts';
import { revealFoe } from '../../src/learn/viewer.ts';
import { search, top3 } from '../../src/search/mcts.ts';
import type { Position, Action, StatusID } from '../../src/engine/position.ts';

const GAMES = Number(process.argv[2] ?? 30), SEED = Number(process.argv[3] ?? 1);
const PS = loadShowdown();
const dex = PS.Dex.forFormat(FORMAT);
const Runner = makeRunner(PS, FORMAT);
const clone = makeCloner(dex, PS.Pokemon);
const priors = JSON.parse(readFileSync('data/priors/sets.json', 'utf8'));
const teams = JSON.parse(readFileSync('data/seed/teams_m7.json', 'utf8'));
const selections = JSON.parse(readFileSync('data/seed/selections_m7.json', 'utf8'));
const party = JSON.parse(readFileSync('test/fixtures/party-team2-screen.json', 'utf8'));
const ja = JSON.parse(readFileSync('data/names/ja.json', 'utf8'));
const Analyzer = makeAnalyzer(PS, FORMAT, priors, teams, selections);
const validator = PS.TeamValidator.get(FORMAT);
const okTeams = teams.filter((t: any) => !validator.validateTeam(t.mons.map((m: any) => ({ ...m, name: '', level: 50, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 } }))));
const toID = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
let st = SEED * 1000 + 7; const rand = () => { st = (st * 16807) % 2147483647; return st / 2147483647; };
const pick3 = () => [0, 1, 2, 3, 4, 5].sort(() => rand() - 0.5).slice(0, 3);
const setOf = (m: any) => ({ species: m.species, item: toID(m.item), ability: toID(m.ability), nature: m.nature, evs: m.evs, moves: m.moves.map(toID) });

const pred = { n: 0, ourHp: 0, ourAll: 0, oppExact: 0, opp5: 0, oppDiff: [] as number[], first: 0, firstN: 0, active: 0, status: 0, all: 0 };
let turns = 0, lost = 0, hpBad = 0, detBad = 0, searchBad = 0, exact = 0, games = 0;
const scores: number[] = [];
const problems: string[] = [];
for (let g = 0; g < GAMES; g++) {
  const team = okTeams[Math.floor(rand() * okTeams.length)];
  const ourIdx = pick3(), oppIdx = pick3();
  const ours = ourIdx.map(i => setOf(party[i]));
  const oppSets = oppIdx.map(i => setOf(team.mons[i]));
  const oppSpecies = team.mons.map((m: any) => dex.species.get(m.species).name);
  const truthPos: Position = { sides: [
    { mons: ours.map(s => ({ set: s, hp: 999, status: '' as StatusID })), active: 0 },
    { mons: oppSets.map(s => ({ set: s, hp: 999, status: '' as StatusID })), active: 0 },
  ] };
  const truth = new Runner(truthPos, g + 1, true);
  const b = truth.battle;
  const an = new Analyzer({ ours, ourLead: 0, oppSpecies, ourTeamJa: party.map((m: any) => m.jp) });
  // 先発の特性・持ち物（場に出たとき）
  const sinceStart = (from: number) => (b.log as string[]).slice(from);
  // 相手の持ち物・特性の表示の拾い方は、AIどうしの対戦と同じもの（src/learn/viewer.ts）
  const reveal = (lines: string[], oppActiveSpecies: string) => revealFoe(dex, lines, 0, oppActiveSpecies);
  const oppLead = oppIdx[0];
  const r0 = reveal(sinceStart(0), oppSpecies[oppLead]);
  an.start({ oppLead, oppAbility: r0.ability, oppItem: r0.item });
  games++;
  // LOGDIR があれば、画面で保存するのと同じ形の対戦記録と、確かめ用の本当の型（別のファイル）を書き出す
  const logDoc: any = { id: `sim${SEED}-${g}`, partyName: 'チーム2', setup: an.setup, start: { oppLead, oppAbility: r0.ability, oppItem: r0.item }, turns: [], startedAt: '' };
  for (let t = 0; t < 40 && !b.ended; t++) {
    // 両者の行動：ランダム
    const l0 = truth.legalActions(0), l1 = truth.legalActions(1);
    const oppActiveBefore = b.sides[1].active[0];
    const logFrom = b.log.length;
    const turnBefore = b.turn;
    let a0: Action | null = null, a1: Action | null = null;
    // Showdown が行動を受け付けずにターンが進まなかったら、別の行動で打ち直す（記録しない）
    for (let tries = 0; tries < 8 && b.turn === turnBefore && !b.ended; tries++) {
      a0 = l0.length ? l0[Math.floor(rand() * l0.length)] : null;
      a1 = l1.length ? l1[Math.floor(rand() * l1.length)] : null;
      if (b.sides[0].activeRequest && !b.sides[0].activeRequest.wait) b.sides[0].choice = { cantUndo: false, error: '', actions: [], forcedSwitchesLeft: 0, forcedPassesLeft: 0, switchIns: new Set(), zMove: false, mega: false, ultra: false, dynamax: false, terastallize: false };
      if (b.sides[1].activeRequest && !b.sides[1].activeRequest.wait) b.sides[1].choice = { cantUndo: false, error: '', actions: [], forcedSwitchesLeft: 0, forcedPassesLeft: 0, switchIns: new Set(), zMove: false, mega: false, ultra: false, dynamax: false, terastallize: false };
      truth.play(a0, a1);
    }
    if (b.turn === turnBefore && !b.ended) break;
    const lines = sinceStart(logFrom);
    if (process.env.DUMP === `${g}:${t + 1}`) console.log(lines.filter(l => !l.startsWith('|t:|')).join('\n'));
    const own = (l: string) => !l.includes('[from]') || l.includes('[from] lockedmove');
    const moveLines = lines.filter(l => /^\|move\|p[12]a:/.test(l) && own(l));
    const oppMoveLine = lines.find(l => l.startsWith(`|move|p2a: ${oppActiveBefore.name}|`) && own(l));
    const sw = a1?.kind === 'switch' ? oppIdx[a1.to] : -1;
    const opp: TurnInput['opp'] = sw >= 0 ? { kind: 'switch', to: sw }
      : oppMoveLine ? { kind: 'move', move: oppMoveLine.split('|')[3], mega: lines.some(l => l.startsWith('|-mega|p2a')) } : { kind: 'none' };
    const ourMoved = lines.some(l => l.startsWith('|move|p1a') && own(l));
    const oursAct: TurnInput['ours'] = !a0 ? { kind: 'none' } : a0.kind === 'switch' ? a0 : ourMoved ? a0 : { kind: 'none' };
    const bothMoved = oursAct.kind === 'move' && opp.kind === 'move';
    const s1 = b.sides[1].active[0];
    const oppActiveIdx = oppSpecies.findIndex((n: string) => dex.species.get(n).baseSpecies === s1.baseSpecies.baseSpecies);
    const rv = reveal(lines, s1.species.name);
    const ourActive = ours.findIndex(o => dex.species.get(o.species).baseSpecies === b.sides[0].active[0].baseSpecies.baseSpecies);
    const ourHps = ours.map(o => b.sides[0].pokemon.find((p: any) => p.baseSpecies.baseSpecies === dex.species.get(o.species).baseSpecies).hp);
    const input: TurnInput = {
      ours: oursAct, opp,
      first: bothMoved && moveLines.length >= 2 ? (moveLines[0].startsWith('|move|p2a') ? 'them' : 'us') : undefined,
      // CRIT_UNKNOWN=1：画面と同じく「急所だったときだけ印、なければ空（分からない）」。CRIT_FORGET=1：急所を入れ忘れて「急所ではない」と入った場合
      critOnOpp: process.env.CRIT_FORGET ? false : lines.some(l => l.startsWith('|-crit|p2a')) || (process.env.CRIT_UNKNOWN ? undefined : false), critOnUs: process.env.CRIT_FORGET ? false : lines.some(l => l.startsWith('|-crit|p1a')) || (process.env.CRIT_UNKNOWN ? undefined : false),
      oppItem: rv.item, oppAbility: rv.ability,
      ourMega: lines.some(l => l.startsWith('|-mega|p1a')), oppMega: lines.some(l => l.startsWith('|-mega|p2a')),
      after: { ourActive, ourHp: b.sides[0].active[0].hp, ourStatus: (b.sides[0].active[0].status || '') as StatusID, oppActive: oppActiveIdx, oppHpPct: shownPercent(s1.hp, s1.maxhp), oppStatus: (s1.status || '') as StatusID, ourHps },
    };
    // 利用者が「今の状態」欄を画面どおりに直した、という前提で、見えるものは本当の値を渡す
    const boostsOf = (p: any): Record<string, number> => Object.fromEntries(Object.entries(p.boosts as Record<string, number>).filter(([, v]) => v));
    const condOf = (side: any) => { const c: any = {}; for (const k of ['stealthrock', 'spikes', 'toxicspikes', 'stickyweb', 'reflect', 'lightscreen', 'auroraveil', 'tailwind']) if (side.sideConditions[k]) c[k] = side.sideConditions[k].layers ?? 1; return c; };
    const volOf = (p: any) => ({ leechseed: !!p.volatiles.leechseed, substitute: !!p.volatiles.substitute });
    input.visible = { ourItem: b.sides[0].active[0].item, vol: [volOf(b.sides[0].active[0]), volOf(s1)], boosts: [boostsOf(b.sides[0].active[0]), boostsOf(s1)], weather: b.field.weather, terrain: b.field.terrain, trickroom: !!b.field.pseudoWeather.trickroom, cond: [condOf(b.sides[0]), condOf(b.sides[1])] };
    if (b.ended) break;
    if (process.env.DUMP === `${g}:${t + 1}`) {
      console.log('入力', JSON.stringify({ ours: input.ours, opp: input.opp, first: input.first, after: input.after }), '始めの相手', an.setup.oppSpecies[an.oppOrder[an.pos.sides[1].active]], 'a1', JSON.stringify(a1));
      const sp = (p: any) => p.getActionSpeed();
      console.log('本当の素早さ', b.sides.map((sd: any) => `${sd.active[0].name} ${sp(sd.active[0])} ${JSON.stringify(sd.active[0].boosts)} ${sd.active[0].status} ${sd.active[0].item}`).join(' / '), 'TR', !!b.field.pseudoWeather.trickroom);
      console.log('記録係の始めの盤面', JSON.stringify(an.pos.sides.map(x => ({ a: x.mons[x.active].set.species, b: x.mons[x.active].boosts, st: x.mons[x.active].status, mega: x.mons[x.active].mega }))), JSON.stringify(an.pos.field));
    }
    // PREDICT=1：記録の前に、画面に先に入れる予想を出して、本当の結果と比べる
    if (process.env.PREDICT) {
      const pr = an.predict({ ours: input.ours, opp: input.opp });
      if (pr) {
        pred.n++;
        if (pr.ourHps[input.after.ourActive] === input.after.ourHp) pred.ourHp++;
        if (pr.ourHps.every((h: number, k: number) => h === (input.after.ourHps?.[k] ?? h))) pred.ourAll++;
        const d = Math.abs(pr.oppHpPct - input.after.oppHpPct); pred.oppDiff.push(d); if (d === 0) pred.oppExact++; if (d <= 5) pred.opp5++;
        if (input.first) { pred.firstN++; if (pr.first === input.first) pred.first++; }
        if (pr.ourActive === input.after.ourActive && pr.oppActive === input.after.oppActive) pred.active++;
        if ((pr.ourStatus || '') === input.after.ourStatus && (pr.oppStatus || '') === input.after.oppStatus) pred.status++;
        const allOk = pr.ourHps.every((h: number, k: number) => h === (input.after.ourHps?.[k] ?? h)) && d === 0 && (!input.first || pr.first === input.first) && pr.ourActive === input.after.ourActive && pr.oppActive === input.after.oppActive && (pr.ourStatus || '') === input.after.ourStatus && (pr.oppStatus || '') === input.after.oppStatus;
        if (allOk) pred.all++;
      }
    }
    logDoc.turns.push({ input: JSON.parse(JSON.stringify(input)) });
    const res = an.record(input);
    turns++; scores.push(res.score); if (res.score === 0) exact++;
    // 1. 本当の型が消えていない
    for (const [k, i] of oppIdx.entries()) {
      if (!an.opp[i].seen) continue;
      const tset = team.mons[i];
      const post = an.sets[i].posterior();
      const idx = an.sets[i].cands.findIndex(c => !c.generic && toID(c.item) === toID(tset.item) && toID(c.nature) === toID(tset.nature) && JSON.stringify(c.evs) === JSON.stringify(tset.evs) && c.moves.every(m => tset.moves.map(toID).includes(toID(m))));
      if (!post || idx < 0 || post[idx] <= 0) {
        lost++;
        if (problems.length < 60) {
          const c = idx >= 0 ? an.sets[i].cands[idx] : null;
          const why = c ? an.sets[i].clues.map(cl => `${cl.label}=${cl.like(c).toFixed(3)}`).join(' / ') + ` ／ 見えた技：${an.sets[i].moves.join(',')}（本当の技：${tset.moves.join(',')}）` : '本当の型が候補にない';
          problems.push(`試合${g} ターン${t + 1}：${tset.jp}（${tset.item}・${tset.ability}）の本当の型が推定から消えた：${why}`);
        }
      }
    }
    // 2. HP と場の体
    const ap = an.pos;
    if (ap.sides[0].mons[ap.sides[0].active].hp !== b.sides[0].active[0].hp) hpBad++;
    if (an.opp[oppActiveIdx].hpPct !== input.after.oppHpPct) hpBad++;
    // 3・4. 仮の盤面と探索（5ターンに1回）
    if (t % 5 === 0) {
      let roots: any[] = [];
      try { roots = an.determinizations(8, rand).map(p => new Runner(p, 1).battle); } catch (e: any) { detBad++; if (problems.length < 10) problems.push(`試合${g} ターン${t + 1}：仮の盤面を作れない ${e.message}`); continue; }
      const r = search(roots, clone, { timeMs: 1e9, maxIters: 160, rand });
      const tp = top3(r.ours);
      if (!tp.length) searchBad++;
      else for (const x of tp) an.describe(x.choice);
    }
  }
  if (process.env.LOGDIR) {
    mkdirSync(`${process.env.LOGDIR}/logs`, { recursive: true }); mkdirSync(`${process.env.LOGDIR}/truth`, { recursive: true });
    writeFileSync(`${process.env.LOGDIR}/logs/${logDoc.id}.json`, JSON.stringify(logDoc));
    writeFileSync(`${process.env.LOGDIR}/truth/${logDoc.id}.json`, JSON.stringify({ rank: team.rank, oppIdx, oppSets: oppIdx.map(i => team.mons[i]) }));
  }
}
if (process.env.PREDICT && pred.n) {
  const pc = (x: number, n = pred.n) => `${(x / n * 100).toFixed(0)}%`;
  const od = [...pred.oppDiff].sort((a, b) => a - b);
  console.log(`予想（${pred.n}ターン）：こちらの場の体のHPが一致 ${pc(pred.ourHp)}、こちらの3体のHPが全部一致 ${pc(pred.ourAll)}、相手のHP%が一致 ${pc(pred.oppExact)}・5以内 ${pc(pred.opp5)}（差の中央値 ${od[Math.floor(od.length / 2)]}）、先に動いた側が一致 ${pc(pred.first, pred.firstN)}（${pred.firstN}ターン）、場の体が一致 ${pc(pred.active)}、状態異常が一致 ${pc(pred.status)}、全部一致（何も直さなくてよい）${pc(pred.all)}`);
}
const sorted = [...scores].sort((a, b) => a - b);
console.log(`試合 ${games}、ターン ${turns}`);
console.log(`1. 本当の型が推定から消えた回数：${lost}`);
console.log(`2. HP・%が合わなかった回数：${hpBad}`);
console.log(`3. 仮の盤面を作れなかった回数：${detBad}`);
console.log(`4. 探索が手を返さなかった回数：${searchBad}`);
console.log(`5. 再現が入力と完全に合ったターン：${exact} / ${turns}（ずれの点数の中央値 ${sorted[Math.floor(sorted.length / 2)]?.toFixed(2)}、90%点 ${sorted[Math.floor(sorted.length * 0.9)]?.toFixed(2)}）`);
problems.forEach(p => console.log('  ', p));
process.exitCode = lost || hpBad || detBad || searchBad ? 1 : 0;
