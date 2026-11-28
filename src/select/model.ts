// 近い構築の結果から、まだ表のない構築への選出の表を見積もる（種族どうしの相性の足し算）。
// こちらのパーティを決めたうえで、マスの勝率を次の式で表し、保存したすべての表の試合結果に合わせる（重みつきロジスティック回帰）。
//   logit(勝率) = b + Σ（こちらの3匹 a × 相手の3匹の種族 s）W[a][s] / 3 + V[こちらの先発][相手の先発の種族]
// 相手の種族が保存した表に一度も出ていなければ、その種族の項は0（ほかの項だけで見積もる）。
import { pickOf } from './cell.ts';
import { SIZE, type TableStats } from './table.ts';

export interface PairModel { b: number; W: Record<string, number[]>; V: Record<string, number[]>; tables: number; games: number }
export interface TrainTable { species: string[]; stats: TableStats }

const sig = (x: number) => 1 / (1 + Math.exp(-x));
// 種族は id（小文字・記号なし）で持つ（構築データの名前と画面の入力のどちらからでも引けるように）
const toID = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** 特徴：マスごとに (こちらの番号, 相手の種族, 重み) の並び。W の項とV の項を分けて持つ。 */
function features(species: string[], k: number) {
  const r = Math.floor(k / SIZE), c = k % SIZE;
  const a = pickOf(r), o = pickOf(c);
  const w: [number, string][] = [];
  for (const i of a.trio) for (const j of o.trio) w.push([i, toID(species[j])]);
  return { w, v: [a.lead, toID(species[o.lead])] as [number, string] };
}

export function fitPairModel(tables: TrainTable[], opt: { epochs?: number; lr?: number; l2?: number } = {}): PairModel {
  const epochs = opt.epochs ?? 400, lr = opt.lr ?? 0.05, l2 = opt.l2 ?? 1e-4;
  const W: Record<string, number[]> = {}, V: Record<string, number[]> = {};
  const get = (M: Record<string, number[]>, s: string) => M[s] ?? (M[s] = new Array(6).fill(0));
  let games = 0;
  const rows: { w: [number, number[]][]; v: [number, number[]]; n: number; y: number }[] = [];
  for (const t of tables) for (let k = 0; k < SIZE * SIZE; k++) {
    const n = t.stats.n[k]; if (!n) continue;
    const f = features(t.species, k);
    rows.push({ w: f.w.map(([i, s]) => [i, get(W, s)] as [number, number[]]), v: [f.v[0], get(V, f.v[1])], n, y: t.stats.w[k] / n });
    games += n;
  }
  const bias = [0];
  if (!rows.length) return { b: 0, W, V, tables: tables.length, games: 0 };
  const total = rows.reduce((a, r) => a + r.n, 0);
  // 全部のマスで勾配（試合数で重みをつけた平均）を足してから、Adam で動かす
  const params = [bias, ...Object.values(W), ...Object.values(V)];
  const m1 = new Map(params.map(p => [p, new Array(p.length).fill(0)])), m2 = new Map(params.map(p => [p, new Array(p.length).fill(0)]));
  const grad = new Map(params.map(p => [p, new Array(p.length).fill(0)]));
  for (let e = 1; e <= epochs; e++) {
    for (const g of grad.values()) g.fill(0);
    const gb = grad.get(bias)!;
    for (const r of rows) {
      let z = bias[0] + r.v[1][r.v[0]];
      for (const [i, arr] of r.w) z += arr[i] / 3;
      const g = r.n * (sig(z) - r.y) / total;
      gb[0] += g;
      for (const [i, arr] of r.w) grad.get(arr)![i] += g / 3;
      grad.get(r.v[1])![r.v[0]] += g;
    }
    for (const p of params) {
      const g = grad.get(p)!, a = m1.get(p)!, v = m2.get(p)!;
      for (let i = 0; i < p.length; i++) {
        const gi = g[i] + (p === bias ? 0 : l2 * p[i]);
        a[i] = 0.9 * a[i] + 0.1 * gi; v[i] = 0.999 * v[i] + 0.001 * gi * gi;
        p[i] -= lr * (a[i] / (1 - 0.9 ** e)) / (Math.sqrt(v[i] / (1 - 0.999 ** e)) + 1e-8);
      }
    }
  }
  return { b: bias[0], W, V, tables: tables.length, games };
}

/** 相手の6匹の種族 species に対する、マス k の勝率の見積もり。 */
export function predictCell(m: PairModel, species: string[], k: number): number {
  const f = features(species, k);
  let z = m.b + (m.V[f.v[1]]?.[f.v[0]] ?? 0);
  for (const [i, s] of f.w) z += (m.W[s]?.[i] ?? 0) / 3;
  return sig(z);
}
