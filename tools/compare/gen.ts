// ランダムな盤面を作る。上位構築（Showdown の検査を通るもの）から3匹ずつ選び、HP・状態・能力変化・場の状態などを散らす。
import type { Position, PosMon, PosSide, StatusID } from '../../src/engine/position.ts';
import { toID } from '../../src/engine/position.ts';

export class Rng {
  private s: number;
  constructor(s: number) { this.s = s; }
  next(): number { // mulberry32
    let t = (this.s = (this.s + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n: number) { return Math.floor(this.next() * n); }
  chance(p: number) { return this.next() < p; }
  pick<T>(a: readonly T[]): T { return a[this.int(a.length)]; }
}

export function genPosition(rng: Rng, teams: any[], dex: any): Position {
  const sides = [0, 1].map(() => genSide(rng, teams[rng.int(teams.length)], dex)) as [PosSide, PosSide];
  const field: Position['field'] = {};
  if (rng.chance(0.3)) field.weather = { id: rng.pick(['raindance', 'sunnyday', 'sandstorm', 'snowscape']), turns: 1 + rng.int(5) };
  if (rng.chance(0.25)) field.terrain = { id: rng.pick(['electricterrain', 'grassyterrain', 'mistyterrain', 'psychicterrain']), turns: 1 + rng.int(5) };
  if (rng.chance(0.08)) field.trickroom = 1 + rng.int(5);
  return { sides, field };
}

function genSide(rng: Rng, team: any, dex: any): PosSide {
  const idx = [0, 1, 2, 3, 4, 5].sort(() => rng.next() - 0.5).slice(0, 3);
  const mons: PosMon[] = idx.map(i => genMon(rng, team.mons[i], dex));
  // 1匹だけメガシンカ済みにすることがある
  const megaable = mons.map((m, i) => [m, i] as const).filter(([m]) => dex.items.get(m.set.item).megaStone);
  let megaUsed = false;
  if (megaable.length && rng.chance(0.3)) { megaable[rng.int(megaable.length)][0].mega = true; megaUsed = true; }
  // 倒れている控えを作ることがある（場の1匹は必ず生きている）
  const active = rng.int(3);
  for (let i = 0; i < 3; i++) if (i !== active && rng.chance(0.15)) { mons[i].hp = 0; mons[i].status = ''; }
  const cond: PosSide['cond'] = {};
  if (rng.chance(0.2)) cond.stealthrock = true;
  if (rng.chance(0.15)) cond.spikes = 1 + rng.int(3);
  if (rng.chance(0.1)) cond.toxicspikes = 1 + rng.int(2);
  if (rng.chance(0.05)) cond.stickyweb = true;
  if (rng.chance(0.12)) cond.reflect = 1 + rng.int(5);
  if (rng.chance(0.12)) cond.lightscreen = 1 + rng.int(5);
  if (rng.chance(0.05)) cond.auroraveil = 1 + rng.int(5);
  if (rng.chance(0.08)) cond.tailwind = 1 + rng.int(4);
  const side: PosSide = { mons, active, megaUsed, cond };
  const a = mons[active];
  a.vol = {};
  if (rng.chance(0.1)) a.vol.substitute = 1 + rng.int(60);
  if (rng.chance(0.08)) a.vol.confusion = 1 + rng.int(4);
  if (rng.chance(0.08)) a.vol.leechseed = true;
  if (rng.chance(0.06)) a.vol.taunt = 1 + rng.int(3);
  if (rng.chance(0.05)) a.vol.yawn = 1 + rng.int(2);
  if (rng.chance(0.05)) a.vol.focusenergy = true;
  if (dex.items.get(a.set.item).isChoice && !a.itemGone && rng.chance(0.5)) a.vol.choicelock = rng.pick(a.set.moves);
  return side;
}

function genMon(rng: Rng, m: any, dex: any): PosMon {
  const set = { species: m.species, item: toID(m.item), ability: toID(m.ability), nature: m.nature, evs: m.evs, moves: m.moves.map(toID) };
  const sp = dex.species.get(set.species);
  const maxhp = sp.baseStats.hp + set.evs.hp + 75; // チャンピオンズの式（Showdown の champions の statModify と同じ）
  const hp = rng.chance(0.4) ? maxhp : 1 + rng.int(maxhp);
  let status: StatusID = '';
  let statusTime: number | undefined;
  if (rng.chance(0.25)) {
    status = rng.pick(['brn', 'par', 'psn', 'tox', 'slp', 'frz'] as const);
    if (status === 'slp') statusTime = 1 + rng.int(3);
    if (status === 'frz') statusTime = 1 + rng.int(3);
    if (status === 'tox') statusTime = rng.int(6);
  }
  const boosts: PosMon['boosts'] = {};
  if (rng.chance(0.3)) for (const b of ['atk', 'def', 'spa', 'spd', 'spe'] as const) if (rng.chance(0.3)) boosts[b] = rng.int(9) - 4;
  if (rng.chance(0.05)) boosts.accuracy = rng.int(5) - 2;
  if (rng.chance(0.05)) boosts.evasion = rng.int(5) - 2;
  const pp = rng.chance(0.05) ? set.moves.map(() => rng.int(2)) : undefined;
  return { set, hp, status, statusTime, boosts, itemGone: rng.chance(0.08), pp };
}
