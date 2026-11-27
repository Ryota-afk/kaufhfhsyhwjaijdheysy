import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergeEntry, seedKey, itemKey, spreadKey, type LearnedSpecies } from '../src/learn/merge.ts';
import { expandPrior, type PriorEntry } from '../src/infer/sets.ts';
import { BenchModel } from '../src/infer/bench.ts';

const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;
const ev = (hp: number) => ({ hp, atk: 32, def: 0, spa: 0, spd: 0, spe: 32 });

test('型の割合：記録1件＝上位構築1件分として、決めた式どおりに混ざる', () => {
  // 上位構築に3回（型A 2回、型B 1回）出た種族。それ以外の型は役割1つ（持ち物2つ、能力ポイント1つ）
  const A = { w: 2, item: 'Life Orb', ability: 'Rough Skin', nature: 'Jolly', evs: ev(0), moves: ['Earthquake', 'Outrage', 'Swords Dance', 'Protect'] };
  const B = { w: 1, item: 'Choice Scarf', ability: 'Rough Skin', nature: 'Jolly', evs: ev(2), moves: ['Earthquake', 'Outrage', 'Stone Edge', 'Fire Fang'] };
  const e: PriorEntry = { name: 'Garchomp', seedCount: 3, otherWeight: 1 / 4, seed: [A, B],
    generic: [{ role: 'Fast Attacker', pool: ['Earthquake', 'Outrage', 'Crunch', 'Iron Head', 'Swords Dance'], abilities: ['Rough Skin'], items: [{ item: 'Focus Sash', w: 0.5 }, { item: 'Leftovers', w: 0.5 }], spreads: [{ nature: 'Jolly', evs: ev(0), w: 1 }] }] };
  // 記録で2回出会い、型Bに1.5、それ以外の型（きあいのタスキ）に0.5
  const l: LearnedSpecies = { obs: 2, seed: { [seedKey(B)]: 1.5 }, generic: 0.5, items: { [itemKey('Fast Attacker', 'Focus Sash')]: 0.5 }, spreads: { [spreadKey('Fast Attacker', 'Jolly', ev(0))]: 0.5 } };
  const m = mergeEntry(e, l);
  // それ以外の型の割合：(1 + 0.5) / (3 + 1 + 2) = 0.25
  assert.ok(close(m.otherWeight, 1.5 / 6), String(m.otherWeight));
  assert.deepEqual(m.seed.map(s => s.w), [2, 2.5]);
  // それ以外の型の持ち物：(0.5 + 0.5)/(1 + 0.5)、(0.5 + 0)/(1 + 0.5)
  assert.ok(close(m.generic[0].items[0].w, 1 / 1.5) && close(m.generic[0].items[1].w, 0.5 / 1.5));
  // 展開した最初の確率：型A = (1−0.25)×2/4.5、型B = (1−0.25)×2.5/4.5
  const c = expandPrior(m);
  assert.ok(close(c[0].prior, 0.75 * 2 / 4.5) && close(c[1].prior, 0.75 * 2.5 / 4.5));
  // 記録のない種族は変わらない
  assert.equal(mergeEntry(e, undefined), e);
});

test('選出の傾向：記録1件＝上位構築1件分として、種族の割合と構築の3体の組に足される', () => {
  const teams = JSON.parse(readFileSync('data/seed/teams_m7.json', 'utf8'));
  const sels = JSON.parse(readFileSync('data/seed/selections_m7.json', 'utf8'));
  const b0 = new BenchModel(teams, sels);
  // ガブリアスの割合：上位構築での (合計 S, 回数 n) に、記録の (P, 2) を足して (S+P)/(n+2)。
  // P=1 と P=0 の差は 1/(n+2) なので、そこから n を出し、もとの割合 S/n と合うかを見る
  const r0 = b0.speciesRate('Garchomp');
  const r1 = new BenchModel(teams, sels, { rates: { garchomp: [1.0, 2] }, teams: {} }).speciesRate('Garchomp');
  const r3 = new BenchModel(teams, sels, { rates: { garchomp: [0, 2] }, teams: {} }).speciesRate('Garchomp');
  const n = 1 / (r1 - r3) - 2, S = r3 * (n + 2);
  assert.ok(n > 10 && close(n, Math.round(n), 1e-6) && close(S / n, r0, 1e-9), `n=${n} S=${S} r0=${r0}`);
  // 1位の構築：記録1件で 0,1,2 の組が確率1 → (もとの確率 + 1) / 2
  const t1 = teams.find((t: any) => t.rank === 1);
  const sp = t1.mons.map((m: any) => m.species);
  const p0 = b0.prior(sp, []).get('0,1,2')!;
  const b2 = new BenchModel(teams, sels, { rates: {}, teams: { 1: { n: 1, trios: { '0,1,2': 1 } } } });
  assert.ok(close(b2.prior(sp, []).get('0,1,2')!, (p0 + 1) / 2));
});
