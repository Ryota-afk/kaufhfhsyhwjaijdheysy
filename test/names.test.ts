import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ja = JSON.parse(readFileSync('data/names/ja.json', 'utf8'));
const teams = JSON.parse(readFileSync('data/seed/teams_m7.json', 'utf8'));
const dex = JSON.parse(readFileSync('src/engine/data/dex.json', 'utf8'));
const toID = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

test('日本語名：上位206構築の日本語の種族名と一致する', () => {
  for (const t of teams) for (const m of t.mons) assert.equal(ja.species[toID(m.species)], m.jp, `${t.rank}位 ${m.species}`);
});
test('日本語名：上位構築の技・持ち物・特性はすべて日本語名がある', () => {
  for (const t of teams) for (const m of t.mons) {
    for (const mv of m.moves) assert.ok(ja.moves[toID(mv)], mv);
    assert.ok(ja.items[toID(m.item)], m.item);
    if (m.ability) assert.ok(ja.abilities[toID(m.ability)], m.ability);
  }
});
test('日本語名：チャンピオンズで使える技・持ち物・性格はすべて日本語名がある', () => {
  for (const id of Object.keys(dex.moves)) assert.ok(ja.moves[id], id);
  for (const id of Object.keys(dex.items)) assert.ok(ja.items[id], id);
  assert.equal(Object.keys(ja.natures).length, 25);
});
test('日本語名：ポケモンと技と持ち物で、同じ表示名が重ならない', () => {
  for (const k of ['species', 'moves', 'items']) {
    const seen = new Map<string, string>();
    for (const [id, v] of Object.entries(ja[k] as Record<string, string>)) {
      assert.ok(!seen.has(v), `${k}：${v}（${seen.get(v)} と ${id}）`);
      seen.set(v, id);
    }
  }
});
