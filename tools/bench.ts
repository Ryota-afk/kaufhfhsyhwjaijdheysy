// 速さの測定：上位構築どうしでランダムな行動の対戦を回し、1秒あたりのターン数を出す（準備の時間は除く）。
// 使い方：npm run bench -- [plain|fast] [秒]
import { readFileSync } from 'node:fs';
import { loadShowdown, FORMAT } from './showdown/load.ts';
import { applySpeedLayer } from '../src/engine/fast.ts';
import { makeCloner } from '../src/engine/clone.ts';
const mode = process.argv[2] ?? 'fast';
const secs = Number(process.argv[3] ?? 8);
const PS = loadShowdown();
if (mode === 'fast') applySpeedLayer(PS, PS.Battle, FORMAT);
const clone = makeCloner(PS.Dex.forFormat(FORMAT), PS.Pokemon);
const teams = JSON.parse(readFileSync('data/seed/teams_m7.json', 'utf8')).filter((t: any) => t.mons.every((m: any) => m.ability));
const toSets = (t: any) => t.mons.map((m: any) => ({ name: '', species: m.species, item: m.item, ability: m.ability, nature: m.nature, evs: m.evs, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }, moves: m.moves, level: 50, gender: '' }));
let st = 7; const rnd = (n: number) => { st = (st * 1103515245 + 12345) & 0x7fffffff; return st % n; };
function choose(b: any, side: any) {
  const req = side.activeRequest; if (!req || req.wait) return;
  const opts: string[] = [];
  if (req.forceSwitch) { side.pokemon.forEach((p: any, i: number) => { if (i > 0 && !p.fainted) opts.push('switch ' + (i + 1)); }); b.choose(side.id, opts.length ? opts[rnd(opts.length)] : 'pass'); return; }
  const act = req.active[0];
  act.moves.forEach((m: any, i: number) => { if (!m.disabled) opts.push('move ' + (i + 1)); });
  if (!act.trapped) side.pokemon.forEach((p: any, i: number) => { if (i > 0 && !p.fainted) opts.push('switch ' + (i + 1)); });
  if (!opts.length || !b.choose(side.id, opts[rnd(opts.length)])) b.choose(side.id, 'default');
}
let turns = 0, games = 0, simMs = 0, clones = 0, cloneMs = 0;
const end = performance.now() + secs * 1000;
while (performance.now() < end) {
  const b = new PS.Battle({ formatid: FORMAT, seed: [rnd(65535), rnd(65535), rnd(65535), rnd(65535)].join(',') });
  b.setPlayer('p1', { name: 'a', team: PS.Teams.pack(toSets(teams[rnd(teams.length)])) });
  b.setPlayer('p2', { name: 'b', team: PS.Teams.pack(toSets(teams[rnd(teams.length)])) });
  b.choose('p1', 'team 123'); b.choose('p2', 'team 123');
  const t0 = performance.now();
  let guard = 0;
  while (!b.ended && guard++ < 200) { const t = b.turn; choose(b, b.p1); choose(b, b.p2); if (b.turn !== t) turns++; }
  simMs += performance.now() - t0;
  const c0 = performance.now(); clone(b); cloneMs += performance.now() - c0; clones++;
  games++;
}
console.log(`${mode}: ${games}試合、${turns}ターン、1秒あたり ${(turns / simMs * 1000).toFixed(0)} ターン、複製1回 ${(cloneMs / clones * 1000).toFixed(0)}µs`);
