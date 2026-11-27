// 上位構築の表がない相手の、試合に使う型：最初の型の候補（data/priors/sets.json）の中で、いちばん重いもの。
export function likelySet(entry: any): { species: string; item: string; ability: string; nature: string; evs: any; moves: string[] } | null {
  if (!entry) return null;
  if (entry.seed?.length) {
    const s = [...entry.seed].sort((a: any, b: any) => b.w - a.w)[0];
    return { species: entry.name, item: s.item, ability: s.ability, nature: s.nature, evs: s.evs, moves: s.moves };
  }
  const g = entry.generic?.[0];
  if (!g) return null;
  const top = (xs: any[]) => [...(xs ?? [])].sort((a, b) => b.w - a.w)[0];
  const item = top(g.items)?.item ?? '', spread = top(g.spreads);
  return { species: entry.name, item, ability: g.abilities?.[0] ?? '', nature: spread?.nature ?? 'Hardy', evs: spread?.evs ?? { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }, moves: (g.pool ?? []).slice(0, 4) };
}
