// 開発用：複製で写している物の数を、種類ごとに数える。
import { readFileSync } from 'node:fs';
import { loadShowdown, FORMAT } from '../showdown/load.ts';
const PS = loadShowdown();
const teams = JSON.parse(readFileSync('data/seed/teams_m7.json', 'utf8'));
const toSets = (t: any) => t.mons.map((m: any) => ({ name: '', species: m.species, item: m.item, ability: m.ability, nature: m.nature, evs: m.evs, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }, moves: m.moves, level: 50, gender: '' }));
const b = new PS.Battle({ formatid: FORMAT, seed: '1,2,3,4' });
b.setPlayer('p1', { name: 'a', team: PS.Teams.pack(toSets(teams[0])) });
b.setPlayer('p2', { name: 'b', team: PS.Teams.pack(toSets(teams[1])) });
b.choose('p1', 'team 123'); b.choose('p2', 'team 123');
for (let i = 0; i < 3; i++) { b.choose('p1', 'move 1'); b.choose('p2', 'move 1'); }
const seen = new Set(); const cnt: Record<string, number> = {}; const path: Record<string, string> = {};
const walk = (v: any, p: string) => {
  if (v === null || typeof v !== 'object' || seen.has(v)) return; seen.add(v);
  const n = v.constructor?.name ?? 'null';
  if (['Species', 'Item', 'Ability', 'Condition', 'Nature', 'TypeInfo', 'Format', 'RuleTable', 'ModdedDex', 'Learnset'].includes(n) || n.startsWith('Dex')) return;
  cnt[n] = (cnt[n] ?? 0) + 1; if (!path[n]) path[n] = p;
  if (n === 'DataMove') { cnt['DataMove:' + p.split('.').slice(-2).join('.')] = (cnt['DataMove:' + p.split('.').slice(-2).join('.')] ?? 0) + 1; }
  for (const k of Object.keys(v)) walk(v[k], p + '.' + k);
};
walk(b, 'b');
console.log(Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 25), path['DataMove'], b.log.length);
import { makeCloner } from '../../src/engine/clone.ts';
const clone = makeCloner(PS.Dex.forFormat(FORMAT));
for (let i = 0; i < 2000; i++) clone(b);
let t0 = performance.now(); for (let i = 0; i < 20000; i++) clone(b);
console.log('速い複製', ((performance.now() - t0) / 20000 * 1000).toFixed(1), 'µs');
b.log = []; b.inputLog = [];
t0 = performance.now(); for (let i = 0; i < 20000; i++) clone(b);
console.log('記録を空にした後', ((performance.now() - t0) / 20000 * 1000).toFixed(1), 'µs');
t0 = performance.now(); for (let i = 0; i < 2000; i++) PS.State.deserializeBattle(PS.State.serializeBattle(b));
console.log('Showdown付属', ((performance.now() - t0) / 2000 * 1000).toFixed(1), 'µs');
