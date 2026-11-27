// 相手の選出（6体から3体）の推定と、見えていない控えの確率。
// もと：data/seed/selections_m7.json（記事から整理した選出）と data/seed/teams_m7.json。
//  - 記事の選出1件は、その枠に入りうる体から等しく選んだ3体の組（空の枠は残りの体から等しく選ぶ）として数える。
//    「基本選出」が何回あるか（freq）は文で書かれていて数にできないので、1件を同じ重みにする（推定）。
//  - 構築の6体がそのまま上位構築と同じなら、その構築の選出の割合を使う。こちらのポケモンに対する出し分け（conditional）が
//    当てはまれば、それと基本の選出を半分ずつ混ぜる（推定）。
//  - 同じ構築がなければ、種族ごとの「選出に入る割合」r を使い、3体の組の確率を Π r × Π (1-r) に比例させる（推定）。
//    上位構築にない種族は r = 0.5。
export type Trio = [number, number, number];
const toID = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

export const ALL_TRIOS: Trio[] = (() => {
  const t: Trio[] = [];
  for (let a = 0; a < 6; a++) for (let b = a + 1; b < 6; b++) for (let c = b + 1; c < 6; c++) t.push([a, b, c]);
  return t;
})();
const key = (t: number[]) => [...t].sort((x, y) => x - y).join(',');

/** 記事の選出1件（slots）を、3体の組の分布にする。 */
export function trioDist(slots: number[][]): Map<string, number> {
  const out = new Map<string, number>();
  // 決まっている枠から先に埋める（空の枠が「残りの体から等しく」になるように）
  const ordered = [...slots].sort((a, b) => (b?.length ? 1 : 0) - (a?.length ? 1 : 0));
  const rec = (i: number, chosen: number[], p: number) => {
    if (i === 3) { const k = key(chosen); out.set(k, (out.get(k) ?? 0) + p); return; }
    const opts = (ordered[i]?.length ? ordered[i] : [0, 1, 2, 3, 4, 5]).filter(x => !chosen.includes(x));
    if (!opts.length) return; // 矛盾する記述（同じ体が2つの枠に固定）は捨てる
    for (const x of opts) rec(i + 1, [...chosen, x], p / opts.length);
  };
  rec(0, [], 1);
  const total = [...out.values()].reduce((a, b) => a + b, 0);
  if (total > 0) for (const [k, v] of out) out.set(k, v / total);
  return out;
}

function mix(dists: Map<string, number>[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const d of dists) for (const [k, v] of d) out.set(k, (out.get(k) ?? 0) + v / dists.length);
  return out;
}
const uniform = () => new Map(ALL_TRIOS.map(t => [key(t), 1 / ALL_TRIOS.length]));
export const SMOOTH = 0.1;
const smooth = (d: Map<string, number>) => new Map(ALL_TRIOS.map(t => [key(t), (1 - SMOOTH) * (d.get(key(t)) ?? 0) + SMOOTH / ALL_TRIOS.length]));

export interface SelectionEntry { rank: number; has_info: boolean; base: { slots: number[][] }[]; conditional: { slots: number[][]; opp_species: string[] }[] }

export class BenchModel {
  private teamDist = new Map<number, Map<string, number>>();      // 順位 → 3体の組の分布（基本）
  private rate = new Map<string, number>();                       // 種族 → 選出に入る割合
  /** learned：対戦記録から数えた選出（src/learn/merge.ts の Learned['bench']）。記録1件を上位構築1件分として足す。 */
  private teams: any[];
  private selections: SelectionEntry[];
  constructor(teams: any[], selections: SelectionEntry[], learned?: { rates: Record<string, [number, number]>; teams: Record<string, { n: number; trios: Record<string, number> }> }) {
    this.teams = teams; this.selections = selections;
    const byRank = new Map(teams.map(t => [t.rank, t]));
    const sum = new Map<string, [number, number]>();
    for (const sel of selections) {
      const t = byRank.get(sel.rank); if (!t || !sel.has_info) continue;
      const src = sel.base.length ? sel.base : sel.conditional;
      if (!src.length) continue;
      // 記事にない3体の組も、実際には出てくることがある。確率が0だと、見えた体に合う組がなくなり、記録からも数えられないので、
      // どの組も同じ割合の分布を1割だけ混ぜる（1割は推定。2026-11-27）
      const d = smooth(mix(src.map(e => trioDist(e.slots))));
      this.teamDist.set(sel.rank, d);
      t.mons.forEach((m: any, i: number) => {
        let p = 0; for (const [k, v] of d) if (k.split(',').map(Number).includes(i)) p += v;
        const s = sum.get(toID(m.species)) ?? [0, 0]; s[0] += p; s[1]++; sum.set(toID(m.species), s);
      });
    }
    if (learned) {
      for (const [sp, [p, n]] of Object.entries(learned.rates)) { const s = sum.get(sp) ?? [0, 0]; sum.set(sp, [s[0] + p, s[1] + n]); }
      for (const [rank, lt] of Object.entries(learned.teams)) {
        if (!byRank.has(Number(rank)) || lt.n <= 0) continue;
        // 記事の選出がない構築は、どの3体の組も同じ割合を1件分として始める
        const base = this.teamDist.get(Number(rank)) ?? uniform();
        const d = new Map<string, number>();
        for (const t of ALL_TRIOS) { const k = key(t); d.set(k, ((base.get(k) ?? 0) + (lt.trios[k] ?? 0)) / (1 + lt.n)); }
        this.teamDist.set(Number(rank), d);
      }
    }
    for (const [sp, [p, n]] of sum) this.rate.set(sp, p / n);
  }
  speciesRate(species: string) { return this.rate.get(toID(species)) ?? 0.5; }

  /**
   * 相手の6体（species、英語名）と、こちらの6体の日本語名（conditional の照合用）から、3体の組の分布を作る。
   */
  prior(opp: string[], ourJa: string[]): Map<string, number> {
    const ids = opp.map(toID);
    const same = this.teams.find(t => t.mons.length === 6 && key(t.mons.map((m: any) => ids.indexOf(toID(m.species)))) === '0,1,2,3,4,5');
    if (same && this.teamDist.has(same.rank)) {
      // 上位構築の並びから、相手の並びへの番号の付け替え
      const map = same.mons.map((m: any) => ids.indexOf(toID(m.species)));
      const remap = (d: Map<string, number>) => new Map([...d].map(([k, v]) => [key(k.split(',').map(x => map[Number(x)])), v]));
      const base = remap(this.teamDist.get(same.rank)!);
      const sel = this.selections.find(s => s.rank === same.rank);
      const conds = (sel?.conditional ?? []).filter(c => c.opp_species.some(s => ourJa.includes(s)));
      if (!conds.length) return base;
      return mix([base, remap(smooth(mix(conds.map(c => trioDist(c.slots)))))]);
    }
    const r = ids.map(s => this.speciesRate(s));
    const out = new Map<string, number>();
    let total = 0;
    for (const t of ALL_TRIOS) {
      let p = 1; for (let i = 0; i < 6; i++) p *= t.includes(i) ? r[i] : 1 - r[i];
      out.set(key(t), p); total += p;
    }
    for (const [k, v] of out) out.set(k, v / total);
    return out;
  }

  /** 見えた体（番号）を条件にして、各体が選出に入っている確率。 */
  static inclusion(dist: Map<string, number>, revealed: number[]): number[] {
    const p = [0, 0, 0, 0, 0, 0]; let total = 0;
    for (const [k, v] of dist) {
      const t = k.split(',').map(Number);
      if (!revealed.every(i => t.includes(i))) continue;
      total += v; for (const i of t) p[i] += v;
    }
    return total > 0 ? p.map(x => x / total) : p;
  }
  static uniform = uniform;
}
