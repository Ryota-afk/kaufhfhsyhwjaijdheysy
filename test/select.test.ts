import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveMatrix, doubleOracle } from '../src/select/solve.ts';

const close = (a: number, b: number, eps = 1e-9, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} と ${b} が違う`);
/** 釣り合いの条件：こちらの確率に対して相手のどの列も v 以上、相手の確率に対してこちらのどの行も v 以下 */
function checkEquilibrium(A: number[][], s: { value: number; row: number[]; col: number[] }) {
  const m = A.length, n = A[0].length;
  close(s.row.reduce((a, b) => a + b, 0), 1, 1e-9, '行の確率の合計');
  close(s.col.reduce((a, b) => a + b, 0), 1, 1e-9, '列の確率の合計');
  assert.ok(s.row.every(x => x >= -1e-12) && s.col.every(x => x >= -1e-12), '確率が負');
  for (let j = 0; j < n; j++) { let v = 0; for (let i = 0; i < m; i++) v += s.row[i] * A[i][j]; assert.ok(v >= s.value - 1e-9, `列${j}で ${v} < ${s.value}`); }
  for (let i = 0; i < m; i++) { let v = 0; for (let j = 0; j < n; j++) v += s.col[j] * A[i][j]; assert.ok(v <= s.value + 1e-9, `行${i}で ${v} > ${s.value}`); }
}

test('じゃんけん：両者とも1/3ずつ、勝率1/2', () => {
  const A = [[0.5, 0, 1], [1, 0.5, 0], [0, 1, 0.5]];
  const s = solveMatrix(A);
  close(s.value, 0.5);
  s.row.forEach(x => close(x, 1 / 3)); s.col.forEach(x => close(x, 1 / 3));
  checkEquilibrium(A, s);
});

test('偏ったコイン合わせ：手で計算した答えと一致', () => {
  // [[a, b], [c, d]] = [[0.8, 0.3], [0.4, 0.6]]：p = (d−c)/(a−b−c+d) = 0.2/0.7、値 = (ad−bc)/(a−b−c+d) = 0.36/0.7
  const A = [[0.8, 0.3], [0.4, 0.6]];
  const s = solveMatrix(A);
  close(s.row[0], 0.2 / 0.7); close(s.col[0], 0.3 / 0.7); close(s.value, 0.36 / 0.7);
});

test('支配される行と列には確率がつかない。純粋な手で釣り合う表', () => {
  const A = [[0.6, 0.7, 0.9], [0.4, 0.5, 0.8], [0.55, 0.65, 0.95]];
  // 行0 は行1 より常によい。列0 は相手にとって常によい。行0と行2で列0の値は 0.6 > 0.55
  const s = solveMatrix(A);
  close(s.value, 0.6); close(s.row[0], 1); close(s.col[0], 1);
  checkEquilibrium(A, s);
});

test('ランダムな表（60×60 ほか）：釣り合いの条件を満たし、ダブルオラクルの値も全体で解いた値と一致', () => {
  let st = 12345; const rand = () => { st = (st * 16807) % 2147483647; return st / 2147483647; };
  for (const [m, n] of [[3, 5], [7, 4], [20, 20], [60, 60]]) {
    for (let k = 0; k < 5; k++) {
      const A = Array.from({ length: m }, () => Array.from({ length: n }, () => rand()));
      const s = solveMatrix(A);
      checkEquilibrium(A, s);
      let calls = 0;
      const d = doubleOracle((i, j) => { calls++; return A[i][j]; }, m, n);
      close(d.value, s.value, 1e-7, `${m}×${n} の値`);
      assert.ok(d.lower <= d.value + 1e-9 && d.value <= d.upper + 1e-9);
      close(d.lower, d.upper, 1e-7, '上と下の差');
      if (m === 60 && k === 0) console.log(`60×60：ダブルオラクルで使った行 ${d.rows.length}、列 ${d.cols.length}、マスを読んだ回数 ${calls}（重複あり）`);
    }
  }
});

import { emptyStats, estimate, nextWork, solveTable, SIZE } from '../src/select/table.ts';
import { fitPairModel, predictCell } from '../src/select/model.ts';
import { pickOf, indexOf, TRIOS } from '../src/select/cell.ts';
import { spotSolve } from '../src/select/spot.ts';
import { partyKey } from '../src/select/key.ts';

test('行・列の番号：20通りの3匹×先発3通り＝60。番号と（3匹, 先発）が行き来できる', () => {
  assert.equal(TRIOS.length, 20);
  for (let k = 0; k < 60; k++) { const p = pickOf(k); assert.equal(indexOf(p.trio, p.lead), k); assert.equal(p.order[0], p.lead); }
});

test('試合を足す順番：まず全部のマスを n0 試合、その後は答えを左右するマスだけ。全部満たすと終わり', () => {
  // 本当の勝率：こちらの行0〜2 が強く、相手の列0〜2 が強い表
  const truth = (k: number) => { const r = Math.floor(k / SIZE), c = k % SIZE; return 0.5 + (r < 3 ? 0.2 : -0.1) - (c < 3 ? 0.2 : -0.1) + ((r + c) % 3 === 0 ? 0.05 : 0); };
  const s = emptyStats();
  let w = nextWork(s, 2, [4, 8]);
  assert.equal(w.need.size, SIZE * SIZE);
  for (const [k, need] of w.need) { s.n[k] += need; s.w[k] += need * truth(k); }
  w = nextWork(s, 2, [4, 8]);
  assert.ok(w.need.size > 0 && w.need.size < SIZE * SIZE, `答えを左右するマスだけ：${w.need.size}`);
  for (const [k] of w.need) { const r = Math.floor(k / SIZE), c = k % SIZE; assert.ok(w.sol!.support.rows.includes(r) || w.sol!.support.cols.includes(c)); }
  for (let i = 0; i < 5 && !w.done; i++) { for (const [k, need] of w.need) { s.n[k] += need; s.w[k] += need * truth(k); } w = nextWork(s, 2, [4, 8]); }
  assert.ok(w.done);
  const sol = solveTable(s);
  assert.ok(sol.support.rows.every(r => r < 3), `強い行だけを使う：${sol.support.rows}`);
});

test('相性の見積もり：種族どうしの相性で作った表から学ぶと、学んでいない並びの構築の表も見積もれる', () => {
  // こちらのポケモン i と相手の種族 s の相性 h(i, s)。勝率 = sig(平均の相性)
  const sp = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  const h = (i: number, s: string) => Math.sin(i * 7 + s.charCodeAt(0)) * 1.2;
  const sig = (x: number) => 1 / (1 + Math.exp(-x));
  const truthOf = (species: string[], k: number) => { const a = pickOf(Math.floor(k / SIZE)), o = pickOf(k % SIZE); let z = 0; for (const i of a.trio) for (const j of o.trio) z += h(i, species[j]) / 3; return sig(z); };
  const make = (species: string[]) => { const s = emptyStats(); for (let k = 0; k < SIZE * SIZE; k++) { s.n[k] = 20; s.w[k] = 20 * truthOf(species, k); } return { species, stats: s }; };
  const train = [['A', 'B', 'C', 'D', 'E', 'F'], ['C', 'D', 'E', 'F', 'G', 'H'], ['A', 'B', 'G', 'H', 'C', 'E'], ['B', 'D', 'F', 'H', 'A', 'G']].map(make);
  const m = fitPairModel(train, { epochs: 600 });
  const test = ['H', 'A', 'F', 'C', 'G', 'D'];   // 学んでいない並び
  let err = 0;
  for (let k = 0; k < SIZE * SIZE; k++) err += Math.abs(predictCell(m, test, k) - truthOf(test, k));
  err /= SIZE * SIZE;
  assert.ok(err < 0.02, `平均の誤差 ${err}`);
});

test('その場の計算：時間内で止まり、保存した試合に書き足す。入力が変わったら途中でやめる', async () => {
  const s = emptyStats();
  const play = async (r: number, c: number) => { await new Promise(res => setTimeout(res, 1)); return r < 3 && c > 3 ? 1 : 0; };
  const r = await spotSolve({ stats: s, timeMs: 300, workers: 4, play });
  assert.ok(r.games > 0 && r.ms < 600, `${r.games}試合、${r.ms}ミリ秒`);
  assert.equal(s.n.reduce((a, b) => a + b, 0), r.games);
  let stop = false;
  setTimeout(() => { stop = true; }, 50);
  const r2 = await spotSolve({ stats: emptyStats(), timeMs: 5000, workers: 4, play, cancelled: () => stop });
  assert.ok(r2.ms < 500, `やめるまで ${r2.ms}ミリ秒`);
});

test('パーティの目印：名前や印を変えても同じ、型を変えると違う', () => {
  const mons = [{ species: 'Garchomp', item: 'Choice Scarf', ability: 'Rough Skin', nature: 'Jolly', evs: { hp: 0 }, moves: ['Earthquake'], gender: 'M' }];
  const k = partyKey(mons);
  assert.equal(partyKey([{ ...mons[0], gender: 'F' }]), k);
  assert.notEqual(partyKey([{ ...mons[0], item: 'Life Orb' }]), k);
});

test('相性の見積もり＋少しの試合で作った表でも、釣り合いを正しく解く（2026-11-27 に本物の見積もりで、回り続けて誤った値 -91% を出した例）', async () => {
  const { readFileSync } = await import('node:fs');
  // その日の相性の見積もり（チーム2）と、表のない8位の構築の6匹
  const model = JSON.parse(readFileSync('test/fixtures/model-team2-20261127.json', 'utf8'));
  const teams = JSON.parse(readFileSync('data/seed/teams_m7.json', 'utf8'));
  const species = teams.find((t: any) => t.rank === 8).mons.map((m: any) => m.species);
  const prior = (k: number) => predictCell(model, species, k);
  let st = 7; const rnd = () => { st = (st * 16807) % 2147483647; return st / 2147483647; };
  for (let trial = 0; trial < 100; trial++) {
    const s = emptyStats();
    const g = 1 + Math.floor(rnd() * 40);
    for (let i = 0; i < g; i++) { const k = Math.floor(rnd() * SIZE * SIZE); s.n[k]++; s.w[k] += rnd() < 0.5 ? 1 : 0; }
    const A = estimate(s, prior);
    const sol = solveMatrix(A);
    checkEquilibrium(A, sol);
    assert.ok(sol.value > 0 && sol.value < 1, `${trial}：値 ${sol.value}`);
  }
});

import { allowedRows } from '../src/select/table.ts';
test('選べる行：メガストーンを持つポケモンが2匹（0番と1番）なら、ちょうど1匹を含む12組×先発3＝36行だけ。いなければ全部', () => {
  const rows = allowedRows(i => i === 0 || i === 1)!;
  assert.equal(rows.length, 36);
  for (const r of rows) { const t = pickOf(r).trio; assert.equal(t.filter(i => i === 0 || i === 1).length, 1); }
  assert.equal(allowedRows(() => false), undefined);
  assert.equal(allowedRows(i => i === 3)!.length, 30);   // 1匹だけなら、その1匹を含む10組
  // 解くと、選べない行の確率は0。試合を足すマスも選べる行だけ
  let st = 5; const rand = () => { st = (st * 16807) % 2147483647; return st / 2147483647; };
  const s = emptyStats();
  for (let k = 0; k < SIZE * SIZE; k++) { s.n[k] = 4; s.w[k] = Math.round(rand() * 4); }
  const sol = solveTable(s, undefined, 0.01, rows);
  const ok = new Set(rows);
  sol.row.forEach((p, r) => { if (!ok.has(r)) assert.equal(p, 0); });
  assert.ok(Math.abs(sol.row.reduce((a, b) => a + b, 0) - 1) < 1e-6);
  const w = nextWork(s, 4, [8], undefined, rows);
  for (const k of w.need.keys()) assert.ok(ok.has(Math.floor(k / SIZE)), `行 ${Math.floor(k / SIZE)} に試合を足さない`);
  const w0 = nextWork(emptyStats(), 4, [8], undefined, rows);
  assert.equal(w0.need.size, 36 * SIZE);
});
