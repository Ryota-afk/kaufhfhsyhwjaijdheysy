// AIどうしの対戦で、片方の側（side：0 は p1、1 は p2）の画面に見えることだけを、対戦の記録係の入力（TurnInput）にする。
// tools/battle/sim-check.ts（p1 だけ）と同じ作り方を、どちらの側からでも作れるようにしたもの。
// 「今の状態」の欄は、利用者が画面どおりに直した前提で、見えるもの（能力ランク・天気・まきびし等）は本当の値を渡す。
import type { TurnInput } from '../battle/analyze.ts';
import type { Action, StatusID } from '../engine/position.ts';
import { shownPercent } from '../infer/calc.ts';

export interface SideView {
  side: 0 | 1;
  mySets: { species: string }[];        // 自分の3体（盤面の並び）
  foeSpecies: string[];                 // 相手の6体（構築の並び）
  foeIdx: number[];                     // 相手の盤面の並び → 構築の番号
}

/**
 * ターンの記録の行 lines から、相手の場の体の持ち物・特性の表示を拾う。Showdown の記録の読み方：
 *  - 「|-ability|体|特性」：その体の特性。「[from] ability: X」がついていれば、その体の本当の特性は X（トレース等。表示の特性は写したもの）
 *  - それ以外の行の「[from] ability: X|[of] 体」：[of] の体の特性が X（さめはだ等）。[of] がなければ行の最初の体
 *  - 「|-item|体|持ち物」「|-enditem|体|持ち物」、「[from] item: X」：持ち物は行の最初の体（[of] があればその体）のもの
 */
export function revealFoe(dex: any, lines: string[], side: 0 | 1, foeActiveSpecies: string) {
  const foe = side === 0 ? 'p2' : 'p1';
  const isFoe = (who: string | undefined) => !!who && who.startsWith(`${foe}a: `) && dex.species.get(who.slice(5)).baseSpecies === dex.species.get(foeActiveSpecies).baseSpecies;
  let item: string | undefined, ability: string | undefined;
  for (const l of lines) {
    const f = l.split('|');
    const kind = f[1], subject = f[2];
    const of = /\[of\] (p[12]a: [^|]*)/.exec(l)?.[1];
    const fromAb = /\[from\] ability: ([^|]*)/.exec(l)?.[1];
    const fromItem = /\[from\] item: ([^|]*)/.exec(l)?.[1];
    if (kind === '-ability') {
      if (isFoe(subject)) ability = fromAb ?? f[3];
    } else if (fromAb) {
      if (isFoe(of ?? subject)) ability = fromAb;
    }
    if (kind === '-item' || kind === '-enditem') {
      if (isFoe(subject) && !fromItem) item = f[3];
    }
    if (fromItem && isFoe(of ?? subject)) item = fromItem;
  }
  return { item, ability };
}

/**
 * 1ターン分の入力を作る。b は本当の対戦（Showdown）、lines はそのターンの記録の行、mine / foe は両者が選んだ行動（盤面の並び）、
 * foeActiveBefore はターンの始めの相手の場の体。
 */
export function sideTurnInput(dex: any, b: any, v: SideView, lines: string[], mine: Action | null, foe: Action | null, foeActiveBefore: any): TurnInput {
  const s = v.side, me = s === 0 ? 'p1' : 'p2', them = s === 0 ? 'p2' : 'p1';
  const mySide = b.sides[s], foeSide = b.sides[1 - s];
  const own = (l: string) => !l.includes('[from]') || l.includes('[from] lockedmove');
  const moveLines = lines.filter(l => /^\|move\|p[12]a:/.test(l) && own(l));
  const foeMoveLine = lines.find(l => l.startsWith(`|move|${them}a: ${foeActiveBefore.name}|`) && own(l));
  const sw = foe?.kind === 'switch' ? v.foeIdx[foe.to] : -1;
  const opp: TurnInput['opp'] = sw >= 0 ? { kind: 'switch', to: sw }
    : foeMoveLine ? { kind: 'move', move: foeMoveLine.split('|')[3], mega: lines.some(l => l.startsWith(`|-mega|${them}a`)) } : { kind: 'none' };
  const iMoved = lines.some(l => l.startsWith(`|move|${me}a`) && own(l));
  const ours: TurnInput['ours'] = !mine ? { kind: 'none' } : mine.kind === 'switch' ? mine : iMoved ? mine : { kind: 'none' };
  const bothMoved = ours.kind === 'move' && opp.kind === 'move';
  const fa = foeSide.active[0], ma = mySide.active[0];
  const oppActive = v.foeSpecies.findIndex(n => dex.species.get(n).baseSpecies === fa.baseSpecies.baseSpecies);
  const rv = revealFoe(dex, lines, s, fa.species.name);
  const ourActive = v.mySets.findIndex(o => dex.species.get(o.species).baseSpecies === ma.baseSpecies.baseSpecies);
  const ourHps = v.mySets.map(o => mySide.pokemon.find((p: any) => p.baseSpecies.baseSpecies === dex.species.get(o.species).baseSpecies).hp);
  const input: TurnInput = {
    ours, opp,
    first: bothMoved && moveLines.length >= 2 ? (moveLines[0].startsWith(`|move|${them}a`) ? 'them' : 'us') : undefined,
    critOnOpp: lines.some(l => l.startsWith(`|-crit|${them}a`)), critOnUs: lines.some(l => l.startsWith(`|-crit|${me}a`)),
    oppItem: rv.item, oppAbility: rv.ability,
    ourMega: lines.some(l => l.startsWith(`|-mega|${me}a`)), oppMega: lines.some(l => l.startsWith(`|-mega|${them}a`)),
    after: { ourActive, ourHp: ma.hp, ourStatus: (ma.status || '') as StatusID, oppActive, oppHpPct: shownPercent(fa.hp, fa.maxhp), oppStatus: (fa.status || '') as StatusID, ourHps },
  };
  // そのターンに場にいた相手の体のうち、ターンの後の場の体以外（交代・とんぼがえり・ドラゴンテール・にげごし・倒れた等）の HP%：画面で見えていた値
  const onField = new Set<any>([foeActiveBefore]);
  for (const l of lines) { const m = new RegExp(`^\\|(?:switch|drag|replace)\\|${them}a: `).exec(l); if (m) { const p = foeSide.active[0] && foeSide.pokemon.find((q: any) => l.includes(`|${q.species.name},`) || l.includes(`|${q.baseSpecies.name},`) || l.split('|')[3]?.startsWith(q.species.name)); if (p) onField.add(p); } }
  const others: Record<number, number> = {};
  for (const p of onField) {
    if (!p || p === fa) continue;
    const bi = v.foeSpecies.findIndex(n => dex.species.get(n).baseSpecies === p.baseSpecies.baseSpecies);
    if (bi >= 0 && bi !== oppActive) others[bi] = shownPercent(p.hp, p.maxhp);
  }
  if (Object.keys(others).length) input.after.oppHps = others;
  const boostsOf = (p: any): Record<string, number> => Object.fromEntries(Object.entries(p.boosts as Record<string, number>).filter(([, x]) => x));
  const condOf = (side: any) => { const c: any = {}; for (const k of ['stealthrock', 'spikes', 'toxicspikes', 'stickyweb', 'reflect', 'lightscreen', 'auroraveil', 'tailwind']) if (side.sideConditions[k]) c[k] = side.sideConditions[k].layers ?? 1; return c; };
  const volOf = (p: any) => ({ leechseed: !!p.volatiles.leechseed, substitute: !!p.volatiles.substitute });
  input.visible = { ourItem: ma.item, vol: [volOf(ma), volOf(fa)], boosts: [boostsOf(ma), boostsOf(fa)], weather: b.field.weather, terrain: b.field.terrain, trickroom: !!b.field.pseudoWeather.trickroom, cond: [condOf(mySide), condOf(foeSide)] };
  return input;
}
