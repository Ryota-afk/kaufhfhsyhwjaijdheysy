// 2つの結果の集まりを、項目ごとの割合で比べる（カイ二乗検定。出現の少ない値はまとめる）。
import type { Outcome } from '../../src/engine/position.ts';

/** 結果を「項目名 → 値」の形に平らにする。 */
export function flatten(o: Outcome): Record<string, string> {
  const r: Record<string, string> = { ended: String(o.ended), winner: String(o.winner) };
  o.sides.forEach((s, si) => {
    r[`s${si}.active`] = String(s.active);
    r[`s${si}.cond`] = JSON.stringify(s.cond);
    s.mons.forEach((m, mi) => {
      for (const k of ['hp', 'status', 'boosts', 'item', 'species', 'vols'] as const) r[`s${si}.m${mi}.${k}`] = String(m[k]);
    });
  });
  for (const [k, v] of Object.entries(o.field)) r[`field.${k}`] = String(v);
  return r;
}

// 正則化された上側不完全ガンマ関数 Q(a, x)（カイ二乗の上側確率に使う）
function gammaQ(a: number, x: number): number {
  if (x <= 0) return 1;
  const lnGa = lgamma(a);
  if (x < a + 1) {
    let sum = 1 / a, del = sum, ap = a;
    for (let n = 0; n < 500; n++) { ap += 1; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-14) break; }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - lnGa);
  }
  let b = x + 1 - a, c = 1 / 1e-300, d = 1 / b, h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a); b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d; const del = d * c; h *= del; if (Math.abs(del - 1) < 1e-14) break;
  }
  return Math.exp(-x + a * Math.log(x) - lnGa) * h;
}
function lgamma(z: number): number {
  const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1; let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/** 2つの集まりで、ある項目の値の割合が同じかを検定し、p値を返す。 */
export function chiSquareP(a: string[], b: string[]): number {
  const ca = new Map<string, number>(), cb = new Map<string, number>();
  for (const x of a) ca.set(x, (ca.get(x) ?? 0) + 1);
  for (const x of b) cb.set(x, (cb.get(x) ?? 0) + 1);
  const keys = [...new Set([...ca.keys(), ...cb.keys()])];
  const na = a.length, nb = b.length, n = na + nb;
  // 期待度数が5未満の値は1つにまとめる
  const bins: [number, number][] = [];
  let rest: [number, number] = [0, 0];
  for (const k of keys) {
    const x = ca.get(k) ?? 0, y = cb.get(k) ?? 0;
    if ((x + y) * Math.min(na, nb) / n < 5) { rest[0] += x; rest[1] += y; } else bins.push([x, y]);
  }
  if (rest[0] + rest[1] > 0) bins.push(rest);
  if (bins.length < 2) return 1;
  let chi = 0;
  for (const [x, y] of bins) {
    const t = x + y;
    const ea = t * na / n, eb = t * nb / n;
    chi += (x - ea) ** 2 / ea + (y - eb) ** 2 / eb;
  }
  return gammaQ((bins.length - 1) / 2, chi / 2);
}

/** 項目ごとに割合を比べ、p値が閾値より小さい項目を返す。 */
export function compareDistributions(A: Outcome[], B: Outcome[], alpha = 1e-4) {
  const fa = A.map(flatten), fb = B.map(flatten);
  const keys = Object.keys(fa[0] ?? {});
  const diffs: { key: string; p: number }[] = [];
  for (const k of keys) {
    const p = chiSquareP(fa.map(x => x[k]), fb.map(x => x[k]));
    if (p < alpha) diffs.push({ key: k, p });
  }
  return diffs;
}
