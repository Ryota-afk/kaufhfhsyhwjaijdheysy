import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { SeedTeam } from '../src/engine/seed-types.ts';

const teams: SeedTeam[] = JSON.parse(readFileSync('data/seed/teams_m7.json', 'utf8'));
const selections: any[] = JSON.parse(readFileSync('data/seed/selections_m7.json', 'utf8'));

test('初期データ：206構築、すべて6匹', () => {
  assert.equal(teams.length, 206);
  for (const t of teams) assert.equal(t.mons.length, 6);
});

test('初期データ：選出の番号は0〜5で、構築の順位と対応する', () => {
  const ranks = new Set(teams.map(t => t.rank));
  for (const s of selections) {
    assert.ok(ranks.has(s.rank), `順位${s.rank}`);
    const all = [...s.base, ...s.conditional].flatMap((x: any) => x.slots.flat());
    for (const i of all) assert.ok(i >= 0 && i <= 5);
  }
});
