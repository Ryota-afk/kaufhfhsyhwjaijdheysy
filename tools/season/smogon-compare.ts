// Smogon の統計（Showdown の対戦場、gen9championsbssregmc、上位の層）と、M-7 の上位構築（記事から取った実際のランクバトルの型）を、
// 種族ごとに比べる。どの項目が現実とずれているかを見て、補いに使うかどうかを決めるための測定。
// 使い方：npx tsx tools/season/smogon-compare.ts [統計のファイル] [上位構築に出た回数の下限=5]
import { readFileSync, writeFileSync } from 'node:fs';
const toID = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const FILE = process.argv[2] ?? 'data/season/raw/smogon_2026-10_gen9championsbssregmc-1760.json';
const MIN = Number(process.argv[3] ?? 5);
const sm = JSON.parse(readFileSync(FILE, 'utf8'));
const teams = JSON.parse(readFileSync('data/seed/teams_m7.json', 'utf8'));
const STATS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
const norm = (m: Map<string, number>) => { const t = [...m.values()].reduce((a, b) => a + b, 0); return new Map([...m].map(([k, v]) => [k, t ? v / t : 0])); };
const tvd = (a: Map<string, number>, b: Map<string, number>) => { let s = 0; for (const k of new Set([...a.keys(), ...b.keys()])) s += Math.abs((a.get(k) ?? 0) - (b.get(k) ?? 0)); return s / 2; };
const top = (m: Map<string, number>) => [...m].sort((x, y) => y[1] - x[1])[0]?.[0] ?? '';
// 能力ポイントの振り方を「32 振った能力」の組で表す（細かい数の違いは見ない）
const maxed = (evs: Record<string, number>) => STATS.filter(s => (evs[s] ?? 0) >= 30).join('+') || 'なし';
const bySp = new Map<string, any[]>();
for (const t of teams) for (const m of t.mons) { const id = toID(m.species); if (!bySp.has(id)) bySp.set(id, []); bySp.get(id)!.push(m); }
// 統計では、メガストーンを持つ型は「Garchomp-Mega-Z」のようにメガシンカ後の姿で別に数えられている。種族ごとに足し合わせる
const smById = new Map<string, any>();
const addInto = (a: Record<string, number>, b: Record<string, number>) => { for (const [k, v] of Object.entries(b)) a[k] = (a[k] ?? 0) + v; };
for (const [k, v] of Object.entries(sm.data) as [string, any][]) {
  const id = toID(k.split('-Mega')[0]);
  const cur = smById.get(id) ?? { 'Raw count': 0, Abilities: {}, Items: {}, Spreads: {}, Moves: {} };
  cur['Raw count'] += v['Raw count'];
  for (const f of ['Abilities', 'Items', 'Spreads', 'Moves']) addInto(cur[f], v[f]);
  smById.set(id, cur);
}
const rows: any[] = [];
for (const [id, mons] of bySp) {
  if (mons.length < MIN) continue;
  const s = smById.get(id);
  if (!s) { rows.push({ id, n: mons.length, missing: true }); continue; }
  const count = Object.values(s.Abilities as Record<string, number>).reduce((a, b) => a + b, 0);
  const real = {
    items: norm(new Map(mons.reduce((m: Map<string, number>, x: any) => m.set(toID(x.item), (m.get(toID(x.item)) ?? 0) + 1), new Map()))),
    abilities: norm(new Map(mons.reduce((m: Map<string, number>, x: any) => m.set(toID(x.ability), (m.get(toID(x.ability)) ?? 0) + 1), new Map()))),
    natures: norm(new Map(mons.reduce((m: Map<string, number>, x: any) => m.set(toID(x.nature), (m.get(toID(x.nature)) ?? 0) + 1), new Map()))),
    spreads: norm(new Map(mons.reduce((m: Map<string, number>, x: any) => m.set(maxed(x.evs), (m.get(maxed(x.evs)) ?? 0) + 1), new Map()))),
  };
  const sNat = new Map<string, number>(), sSp = new Map<string, number>();
  for (const [k, w] of Object.entries(s.Spreads as Record<string, number>)) {
    const [nat, ev] = k.split(':'); const v = ev.split('/').map(Number);
    sNat.set(toID(nat), (sNat.get(toID(nat)) ?? 0) + w);
    const evs = Object.fromEntries(STATS.map((st, i) => [st, v[i]]));
    sSp.set(maxed(evs), (sSp.get(maxed(evs)) ?? 0) + w);
  }
  const smo = { items: norm(new Map(Object.entries(s.Items))), abilities: norm(new Map(Object.entries(s.Abilities))), natures: norm(sNat), spreads: norm(sSp) };
  // 技：採用率（その技を持つポケモンの割合）
  const realMoves = new Map<string, number>();
  for (const x of mons) for (const mv of x.moves) realMoves.set(toID(mv), (realMoves.get(toID(mv)) ?? 0) + 1 / mons.length);
  const smMoves = new Map(Object.entries(s.Moves as Record<string, number>).filter(([k]) => k).map(([k, w]) => [k, w / count]));
  const keys = [...new Set([...realMoves.keys(), ...smMoves.keys()])].filter(k => (realMoves.get(k) ?? 0) >= 0.1 || (smMoves.get(k) ?? 0) >= 0.1);
  const moveDiffs = keys.map(k => ({ k, real: realMoves.get(k) ?? 0, sm: smMoves.get(k) ?? 0 })).sort((a, b) => Math.abs(b.real - b.sm) - Math.abs(a.real - a.sm));
  const moveMean = keys.length ? keys.reduce((a, k) => a + Math.abs((realMoves.get(k) ?? 0) - (smMoves.get(k) ?? 0)), 0) / keys.length : 0;
  rows.push({
    id, n: mons.length, smCount: Math.round(s['Raw count']),
    item: { tvd: tvd(real.items, smo.items), topSame: top(real.items) === top(smo.items), real: top(real.items), sm: top(smo.items) },
    ability: { tvd: tvd(real.abilities, smo.abilities), topSame: top(real.abilities) === top(smo.abilities), real: top(real.abilities), sm: top(smo.abilities) },
    nature: { tvd: tvd(real.natures, smo.natures), topSame: top(real.natures) === top(smo.natures), real: top(real.natures), sm: top(smo.natures) },
    spread: { tvd: tvd(real.spreads, smo.spreads), topSame: top(real.spreads) === top(smo.spreads), real: top(real.spreads), sm: top(smo.spreads) },
    moves: { mean: moveMean, worst: moveDiffs.slice(0, 3).map(d => `${d.k} ${Math.round(d.real * 100)}%/${Math.round(d.sm * 100)}%`) },
  });
}
rows.sort((a, b) => b.n - a.n);
const ok = rows.filter(r => !r.missing);
const wavg = (f: (r: any) => number) => ok.reduce((a, r) => a + f(r) * r.n, 0) / ok.reduce((a, r) => a + r.n, 0);
console.log(`比べた種族 ${ok.length}（上位構築に${MIN}回以上）。統計にない種族 ${rows.filter(r => r.missing).map(r => r.id).join(',') || 'なし'}`);
for (const f of ['item', 'ability', 'nature', 'spread'] as const) console.log(`${f}：ずれ（全変動距離、0=同じ 1=まったく違う）の平均 ${wavg(r => r[f].tvd).toFixed(2)}、いちばん多いものが同じ ${ok.filter(r => r[f].topSame).length}/${ok.length}`);
console.log(`技：採用率の差の平均 ${wavg(r => r.moves.mean).toFixed(2)}`);
console.log('\n種族ごと（上位構築の数、持ち物・特性・性格・能力ポイントのずれ、技の差、技の差の大きいもの 実際/統計）');
for (const r of ok) console.log(`${r.id} ${r.n}：持ち物 ${r.item.tvd.toFixed(2)}${r.item.topSame ? '' : `（${r.item.real}/${r.item.sm}）`} 特性 ${r.ability.tvd.toFixed(2)}${r.ability.topSame ? '' : `（${r.ability.real}/${r.ability.sm}）`} 性格 ${r.nature.tvd.toFixed(2)}${r.nature.topSame ? '' : `（${r.nature.real}/${r.nature.sm}）`} 能力P ${r.spread.tvd.toFixed(2)}${r.spread.topSame ? '' : `（${r.spread.real}/${r.spread.sm}）`} 技 ${r.moves.mean.toFixed(2)}：${r.moves.worst.join('、')}`);
writeFileSync('.build/smogon-compare.json', JSON.stringify(rows, null, 1));

// 補い方の比べ：技・持ち物・性格を1つの型に決めて補うとき、Smogon の統計と、今の補い方（Showdown の型データ＝data/priors の「それ以外の型」）の
// どちらが実際の型に近いか。実際の型ごとに、持ち物・性格が当たるか、技4つのうち何個当たるかを数える。
import { likelySet } from '../../src/select/likely.ts';
const priors = JSON.parse(readFileSync('data/priors/sets.json', 'utf8'));
const topN = (o: Record<string, number>, n: number, skip: (k: string) => boolean = () => false) => Object.entries(o).filter(([k]) => k && !skip(k)).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
let tot = 0; const score = { sm: { item: 0, nature: 0, moves: 0 }, sd: { item: 0, nature: 0, moves: 0 } };
const perSp: string[] = [];
for (const [id, mons] of bySp) {
  if (mons.length < MIN) continue;
  const s = smById.get(id), e = priors.species[id];
  if (!s || !e) continue;
  const smSet = { item: topN(s.Items, 1)[0], nature: toID(topN(s.Spreads, 1)[0].split(':')[0]), moves: topN(s.Moves, 4) };
  const g = likelySet({ ...e, seed: [] });   // 上位構築の型を使わない、Showdown の型データだけの補い
  if (!g) continue;
  const sdSet = { item: toID(g.item), nature: toID(g.nature), moves: g.moves.map(toID) };
  let a = { sm: 0, sd: 0 };
  for (const m of mons) {
    tot++;
    const rm = new Set(m.moves.map(toID));
    for (const [k, set] of [['sm', smSet], ['sd', sdSet]] as const) {
      const sc = (score as any)[k];
      if (set.item === toID(m.item)) sc.item++;
      if (set.nature === toID(m.nature)) sc.nature++;
      const hit = set.moves.filter((x: string) => rm.has(x)).length; sc.moves += hit / 4; (a as any)[k] += hit / 4;
    }
  }
  perSp.push(`${id}：技の当たり Smogon ${(a.sm / mons.length * 4).toFixed(1)}個 ／ Showdown の型データ ${(a.sd / mons.length * 4).toFixed(1)}個`);
}
console.log(`\n補い方の比べ（実際の型 ${tot} 匹）`);
for (const k of ['sm', 'sd'] as const) { const sc = (score as any)[k]; console.log(`${k === 'sm' ? 'Smogon の統計' : 'Showdown の型データ'}：持ち物が当たる ${(sc.item / tot * 100).toFixed(0)}%、性格が当たる ${(sc.nature / tot * 100).toFixed(0)}%、技4つのうち当たる数の平均 ${(sc.moves / tot * 4).toFixed(2)}`); }
if (process.env.PER_SPECIES) console.log(perSp.join('\n'));

// 前のシーズンの上位構築の型で補う方法の当たり方（同じシーズンの、その構築を除いた上位構築から補う。同じシーズンなので甘めの値）
{
  let n = 0, found = 0, item = 0, nature = 0, moves = 0, smMoves = 0, smNature = 0;
  for (const [ti, t] of (teams as any[]).entries()) for (const m of t.mons) {
    const id = toID(m.species);
    if ((bySp.get(id)?.length ?? 0) < MIN) continue;
    n++;
    // 持ち物は公開データで分かる前提。同じ種族・同じ持ち物の型を、ほかの構築から数える
    const others = (teams as any[]).filter((_, j) => j !== ti).flatMap((x: any) => x.mons).filter((x: any) => toID(x.species) === id && toID(x.item) === toID(m.item));
    const rm = new Set(m.moves.map(toID));
    const s = smById.get(id);
    // 持ち物が分かっているときの Smogon（同じ持ち物でしぼれないので、種族全体の上位）
    if (s) { smMoves += topN(s.Moves, 4).filter(x => rm.has(x)).length; if (toID(topN(s.Spreads, 1)[0].split(':')[0]) === toID(m.nature)) smNature++; }
    if (!others.length) continue;
    found++;
    const cnt = (f: (x: any) => string) => { const c = new Map<string, number>(); for (const x of others) c.set(f(x), (c.get(f(x)) ?? 0) + 1); return [...c].sort((a, b) => b[1] - a[1])[0][0]; };
    if (cnt(x => toID(x.nature)) === toID(m.nature)) nature++;
    const mc = new Map<string, number>(); for (const x of others) for (const mv of x.moves) mc.set(toID(mv), (mc.get(toID(mv)) ?? 0) + 1);
    moves += [...mc].sort((a, b) => b[1] - a[1]).slice(0, 4).filter(([k]) => rm.has(k)).length;
    item++;
  }
  console.log(`\n前のシーズンの型で補う方法（代わりに同じシーズンで測った値）：同じ種族・同じ持ち物の型が見つかった ${(found / n * 100).toFixed(0)}%。見つかったときの性格の当たり ${(nature / found * 100).toFixed(0)}%、技4つのうち ${(moves / found).toFixed(2)}個`);
  console.log(`（比べ：同じポケモンを Smogon で補うと、性格 ${(smNature / n * 100).toFixed(0)}%、技 ${(smMoves / n).toFixed(2)}個）`);
}
