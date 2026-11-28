import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadShowdown, FORMAT } from '../tools/showdown/load.ts';
import { makeRunner } from '../src/engine/runner.ts';
import { makeCloner } from '../src/engine/clone.ts';
import { search, top3 } from '../src/search/mcts.ts';
import type { Position } from '../src/engine/position.ts';

const PS = loadShowdown();
const Runner = makeRunner(PS, FORMAT);
const clone = makeCloner(PS.Dex.forFormat(FORMAT), PS.Pokemon);
const party = JSON.parse(readFileSync('test/fixtures/party-team2-screen.json', 'utf8'));
const toID = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const set = (m: any) => ({ species: m.species, item: toID(m.item), ability: toID(m.ability), nature: m.nature, evs: m.evs, moves: m.moves.map(toID) });
let seed = 1; const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

test('探索：相手の最後の1匹（HP30%のドドゲザン）を格闘技で倒せる場面では、格闘技を選ぶ', () => {
  const lucario = party.find((m: any) => m.species === 'Lucario');
  const kingambit = { species: 'Kingambit', item: 'leftovers', ability: 'supremeoverlord', nature: 'Adamant', evs: { hp: 32, atk: 32, def: 0, spa: 0, spd: 2, spe: 0 }, moves: ['kowtowcleave', 'suckerpunch', 'ironhead', 'swordsdance'] };
  const pos: Position = { sides: [
    { mons: [{ set: set(lucario), hp: 147, status: '' }, { set: set(party[0]), hp: 0, status: '' }, { set: set(party[2]), hp: 0, status: '' }], active: 0 },
    { mons: [{ set: kingambit, hp: 60, status: '' }, { set: { ...kingambit, species: 'Gyarados', ability: 'intimidate', moves: ['waterfall'] }, hp: 0, status: '' }, { set: { ...kingambit, species: 'Clefable', ability: 'magicguard', moves: ['moonblast'] }, hp: 0, status: '' }], active: 0 },
  ] };
  const root = new Runner(pos, 1).battle;
  const r = search([root], clone, { timeMs: 60000, maxIters: 1500, rand });
  const t = top3(r.ours);
  assert.ok(t.length >= 2);
  // 1：はどうだん、2：しんくうは（先制）。どちらでも倒せる
  assert.ok(['move 1', 'move 2'].includes(t[0].choice), JSON.stringify(t));
  assert.ok(t[0].winRate > 0.8, JSON.stringify(t));
  assert.ok(t.every(x => x.se > 0 && x.se < 0.2));
});

test('探索：仮に決めた盤面が複数でも、根元の統計がまとまり、回数が配られる', () => {
  const pos: Position = { sides: [
    { mons: party.slice(0, 3).map((m: any) => ({ set: set(m), hp: 999, status: '' })), active: 0 },
    { mons: party.slice(3, 6).map((m: any) => ({ set: set(m), hp: 999, status: '' })), active: 0 },
  ] };
  const roots = [1, 2, 3, 4].map(s => new Runner(pos, s).battle);
  const r = search(roots, clone, { timeMs: 60000, maxIters: 400, rand });
  assert.equal(r.iters, 400);
  assert.deepEqual(r.perRoot, [100, 100, 100, 100]);
  assert.equal(r.ours.reduce((a, s) => a + s.n, 0), 400);
  const t = top3(r.ours);
  assert.equal(t.length, 3);
  for (const x of t) assert.ok(x.winRate >= 0 && x.winRate <= 1);
});
