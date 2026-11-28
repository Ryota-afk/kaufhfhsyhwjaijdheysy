// 対戦記録1件の数え方：記録係で最初から当て直し、対戦の終わりの推定を「記録1件＝上位構築1件分」として数える。
// - 出てきた相手のポケモンごとに、型の確率（合計1）を足す。
// - 相手の6匹それぞれが選出に入っていた確率を足す（出てきたポケモンは1）。
// - 相手の6匹が上位構築と同じなら、その構築の3匹の組の確率（構築の並びの番号）も足す。
// 推定は、記録を数える前の最初の確率（上位構築のデータだけ）で行う（数えた割合が次の数え方に戻らないように）。
import { BenchModel } from '../infer/bench.ts';
import { seedKey, itemKey, spreadKey, emptyLearned, type Learned } from './merge.ts';

const toID = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** 当て直した記録係 an から、1件分を learned に足す。 */
export function addAnalyzer(learned: Learned, an: any, teams: any[], dex: any, priors: { species: Record<string, unknown> }) {
  const species: string[] = an.setup.oppSpecies;
  const seen: number[] = an.opp.map((o: any, i: number) => o.seen ? i : -1).filter((i: number) => i >= 0);
  // 型
  for (const i of seen) {
    const set = an.sets[i];
    const post: number[] | null = set.posterior();
    if (!post) continue;   // 手がかりどうしが矛盾して、どの型も残らなかった（数えない）
    // 記録係と同じく、種族の候補がなければ、もとの種族（姿違いの前）の候補を使っている
    const id = priors.species[toID(species[i])] ? toID(species[i]) : toID(dex.species.get(species[i]).baseSpecies);
    const l = learned.sets[id] ?? (learned.sets[id] = { obs: 0, seed: {}, generic: 0, items: {}, spreads: {} });
    l.obs++;
    set.cands.forEach((c: any, k: number) => {
      const p = post[k]; if (!p) return;
      if (!c.generic) { const key = seedKey(c); l.seed[key] = (l.seed[key] ?? 0) + p; return; }
      l.generic += p;
      const ik = itemKey(c.role, c.item), sk = spreadKey(c.role, c.nature, c.evs);
      l.items[ik] = (l.items[ik] ?? 0) + p;
      l.spreads[sk] = (l.spreads[sk] ?? 0) + p;
    });
  }
  // 選出：見えたポケモンを条件にした、各ポケモンが選出に入っていた確率
  const inc = BenchModel.inclusion(an.benchDist, seen);
  species.forEach((sp, i) => {
    const id = toID(sp);
    const r = learned.bench.rates[id] ?? (learned.bench.rates[id] = [0, 0]);
    r[0] += inc[i]; r[1]++;
  });
  // 上位構築と同じ6匹なら、3匹の組（構築の並び）
  const ids = species.map(toID);
  const same = teams.find((t: any) => t.mons.length === 6 && [...t.mons.map((m: any) => ids.indexOf(toID(m.species)))].sort().join(',') === '0,1,2,3,4,5');
  if (same) {
    const toTeam = ids.map(id => same.mons.findIndex((m: any) => toID(m.species) === id));
    let total = 0;
    const trios = new Map<string, number>();
    for (const [k, v] of an.benchDist as Map<string, number>) {
      const t = k.split(',').map(Number);
      if (!seen.every(i => t.includes(i))) continue;
      const tk = t.map(i => toTeam[i]).sort((a, b) => a - b).join(',');
      trios.set(tk, (trios.get(tk) ?? 0) + v); total += v;
    }
    if (total > 0) {
      const lt = learned.bench.teams[same.rank] ?? (learned.bench.teams[same.rank] = { n: 0, trios: {} });
      lt.n++;
      for (const [k, v] of trios) lt.trios[k] = (lt.trios[k] ?? 0) + v / total;
    }
  }
}

export { emptyLearned };
