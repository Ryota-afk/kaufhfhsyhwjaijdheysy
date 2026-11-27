// 開発用：速い複製が正しいかの確かめ。対戦の途中で複製し、元と複製に同じ行動を打ち続けて、記録が一致するかを見る。
import { readFileSync } from 'node:fs';
import { loadShowdown, FORMAT } from '../showdown/load.ts';
import { makeCloner } from '../../src/engine/clone.ts';
const PS = loadShowdown();
const dex = PS.Dex.forFormat(FORMAT);
const clone = makeCloner(dex, PS.Pokemon);
const teams = JSON.parse(readFileSync('data/seed/teams_m7.json', 'utf8')).filter((t: any) => t.mons.every((m: any) => m.ability));
const toSets = (t: any) => t.mons.map((m: any) => ({ name: '', species: m.species, item: m.item, ability: m.ability, nature: m.nature, evs: m.evs, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }, moves: m.moves, level: 50, gender: '' }));
let rngState = 12345; const rnd = (n: number) => { rngState = (rngState * 1103515245 + 12345) & 0x7fffffff; return rngState % n; };
function choices(b: any, side: any): string[] {
  const req = side.activeRequest; if (!req || req.wait) return [];
  const opts: string[] = [];
  if (req.forceSwitch) { side.pokemon.forEach((p: any, i: number) => { if (i > 0 && !p.fainted) opts.push('switch ' + (i + 1)); }); return opts.length ? opts : ['pass']; }
  const act = req.active[0];
  act.moves.forEach((m: any, i: number) => { if (!m.disabled) { opts.push('move ' + (i + 1)); if (act.canMegaEvo) opts.push(`move ${i + 1} mega`); } });
  if (!act.trapped) side.pokemon.forEach((p: any, i: number) => { if (i > 0 && !p.fainted) opts.push('switch ' + (i + 1)); });
  return opts.length ? opts : ['default'];
}
let ok = 0, bad = 0, cloneUs = 0, desUs = 0, nClone = 0;
for (let g = 0; g < 300; g++) {
  const b = new PS.Battle({ formatid: FORMAT, seed: [g + 1, 2, 3, 4].join(',') });
  b.setPlayer('p1', { name: 'a', team: PS.Teams.pack(toSets(teams[rnd(teams.length)])) });
  b.setPlayer('p2', { name: 'b', team: PS.Teams.pack(toSets(teams[rnd(teams.length)])) });
  b.choose('p1', 'team 123'); b.choose('p2', 'team 123');
  const cut = 1 + rnd(8);
  for (let t = 0; t < cut && !b.ended; t++) for (const s of b.sides) { const c = choices(b, s); if (c.length) b.choose(s.id, c[rnd(c.length)]); }
  if (b.ended) continue;
  let t0 = performance.now(); const c = process.env.MODE === "sd" ? PS.State.deserializeBattle(PS.State.serializeBattle(b)) : clone(b); cloneUs += (performance.now() - t0) * 1000; nClone++;
  t0 = performance.now(); PS.State.deserializeBattle(PS.State.serializeBattle(b)); desUs += (performance.now() - t0) * 1000;
  const startLen = b.log.length;
  for (let t = 0; t < 30 && !b.ended; t++) for (const si of [0, 1]) {
    const opts = choices(b, b.sides[si]); if (!opts.length) continue;
    const ch = opts[rnd(opts.length)];
    b.choose(b.sides[si].id, ch); c.choose(c.sides[si].id, ch);
  }
  const la = b.log.slice(startLen).filter((l: string) => !l.startsWith('|t:|')).join('\n');
  const lb = c.log.slice(startLen).filter((l: string) => !l.startsWith('|t:|')).join('\n');
  if (la === lb && b.ended === c.ended) ok++; else { bad++; if (bad < 3) { const A = la.split('\n'), B = lb.split('\n'); const i = A.findIndex((x: string, k: number) => x !== B[k]); console.log('ずれ', g, A[i], '|', B[i]); } }
}
console.log(`一致 ${ok}、不一致 ${bad}。複製1回：速い複製 ${(cloneUs / nClone).toFixed(0)}µs、Showdown付属の方法 ${(desUs / nClone).toFixed(0)}µs`);
