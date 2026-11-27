// 最初の型の候補（data/priors/sets.json）を作る。
//
// 上位構築に出る種族（seed）：出てきた型をそのまま候補にする（同じ型は重みを足す）。
//   特性が空の個体は、その種族の特性に等分する。
// それ以外の型（generic）：上位構築にない型への備え。重みは「それ以外」を1回分として数える（上位構築に n 回出る種族なら 1/(n+1)）。
//   出ない種族は generic だけ。
// generic の中身：Showdown のチャンピオンズの型データ（data/random-battles/champions/sets.json）の役割ごとに、
//   技の候補（movepool）と特性。持ち物・性格・能力ポイントは、上位構築で同じ組み方の型がよく使うものを、出てきた割合で当てる。
//   メガストーンは、上位構築で「メガシンカできる種族がメガストーンを持っていた割合」で当てる。
// ここでの割合はデータからの推定で、仕組みの事実ではない。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadShowdown, FORMAT, ROOT, showdownCommit } from './showdown/load.ts';

const PS = loadShowdown();
const dex = PS.Dex.forFormat(FORMAT);
const toID = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const teams = JSON.parse(readFileSync(resolve(ROOT, 'data/seed/teams_m7.json'), 'utf8'));
const randomSets = JSON.parse(readFileSync(resolve(ROOT, 'vendor/showdown/data/random-battles/champions/sets.json'), 'utf8'));
type Stats = Record<'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe', number>;

// 組み方の分類（能力ポイントの形）
type Shape = 'fastPhys' | 'fastSpec' | 'bulkyPhys' | 'bulkySpec' | 'physWall' | 'specWall';
function shapeOf(e: Stats): Shape {
  if (e.spe >= 20 && e.atk >= e.spa) return 'fastPhys';
  if (e.spe >= 20) return 'fastSpec';
  if (e.atk >= 20) return 'bulkyPhys';
  if (e.spa >= 20) return 'bulkySpec';
  return e.def >= e.spd ? 'physWall' : 'specWall';
}
const megaOf = (species: any) => dex.items.all().filter((it: any) => it.exists && !it.isNonstandard && it.megaStone && Object.keys(it.megaStone).some(k => toID(k) === species.id || toID(k) === toID(species.baseSpecies)));

// 上位構築から：組み方ごとの持ち物・性格・能力ポイントの出現数、メガストーンを持つ割合
const byShape: Record<string, { items: Map<string, number>; spreads: Map<string, number> }> = {};
let megaCapable = 0, megaHeld = 0;
const seedBySpecies = new Map<string, Map<string, { w: number; set: any }>>();
const seedCount = new Map<string, number>();
for (const t of teams) for (const m of t.mons) {
  const sp = dex.species.get(m.species);
  const item = dex.items.get(m.item);
  const shape = shapeOf(m.evs);
  const bucket = (byShape[shape] ??= { items: new Map(), spreads: new Map() });
  if (!item.megaStone && !item.zMove) bucket.items.set(item.name, (bucket.items.get(item.name) ?? 0) + 1);
  const spreadKey = JSON.stringify({ nature: m.nature, evs: m.evs });
  bucket.spreads.set(spreadKey, (bucket.spreads.get(spreadKey) ?? 0) + 1);
  if (megaOf(sp).length) { megaCapable++; if (item.megaStone) megaHeld++; }
  // seed の型
  const abilities = m.ability ? [dex.abilities.get(m.ability).name] : [...new Set(Object.values(sp.abilities) as string[])];
  const map = seedBySpecies.get(sp.id) ?? new Map();
  for (const ab of abilities) {
    const set = { item: item.name, ability: ab, nature: m.nature, evs: m.evs, moves: m.moves.map((x: string) => dex.moves.get(x).name) };
    const key = JSON.stringify(set);
    const prev = map.get(key);
    map.set(key, { w: (prev?.w ?? 0) + 1 / abilities.length, set });
  }
  seedBySpecies.set(sp.id, map);
  seedCount.set(sp.id, (seedCount.get(sp.id) ?? 0) + 1);
}
const megaRate = megaHeld / megaCapable;

// 役割 → 組み方
function shapesForRole(role: string, phys: boolean): Shape[] {
  switch (role) {
    case 'Fast Attacker': case 'Setup Sweeper': case 'Wallbreaker': case 'Fast Support': return [phys ? 'fastPhys' : 'fastSpec'];
    case 'Bulky Attacker': case 'Bulky Setup': return [phys ? 'bulkyPhys' : 'bulkySpec'];
    case 'Bulky Support': return ['physWall', 'specWall'];
    default: return [phys ? 'fastPhys' : 'fastSpec'];
  }
}
const TOP_ITEMS = 6, TOP_SPREADS = 4;
const top = (m: Map<string, number>, n: number) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

const out: any = {};
const legalSpecies = dex.species.all().filter((s: any) => s.exists && !s.isNonstandard && !s.battleOnly && !s.isMega && s.tier !== 'Illegal');
let noRandom = 0;
for (const sp of legalSpecies) {
  const seedMap = seedBySpecies.get(sp.id);
  const n = seedCount.get(sp.id) ?? 0;
  const seed = seedMap ? [...seedMap.values()].map(x => ({ w: x.w, ...x.set })) : [];
  // 技の候補と特性（Showdown の型データ。なければ上位構築に出た技、それもなければ覚える技すべて）
  const rs = randomSets[sp.id] ?? randomSets[toID(sp.baseSpecies)];
  let roles: { role: string; pool: string[]; abilities: string[] }[];
  if (rs) roles = rs.sets.map((r: any) => ({ role: r.role, pool: r.movepool.map((x: string) => dex.moves.get(x).name), abilities: r.abilities }));
  else {
    noRandom++;
    const pool = seed.length ? [...new Set(seed.flatMap((s: any) => s.moves))] as string[] : [...dex.species.getMovePool(sp.id)].map((id: string) => dex.moves.get(id).name);
    roles = [{ role: 'Unknown', pool, abilities: [...new Set(Object.values(sp.abilities) as string[])] }];
  }
  const megas = megaOf(sp).map((it: any) => it.name);
  const generic = roles.map(r => {
    const dmg = r.pool.map(x => dex.moves.get(x)).filter((mv: any) => mv.category !== 'Status');
    const phys = dmg.filter((mv: any) => mv.category === 'Physical').length >= dmg.filter((mv: any) => mv.category === 'Special').length;
    const shapes = shapesForRole(r.role, phys);
    const items = new Map<string, number>(), spreads = new Map<string, number>();
    for (const sh of shapes) {
      const b = byShape[sh]; if (!b) continue;
      for (const [k, v] of top(b.items, TOP_ITEMS)) items.set(k, (items.get(k) ?? 0) + v);
      for (const [k, v] of top(b.spreads, TOP_SPREADS)) spreads.set(k, (spreads.get(k) ?? 0) + v);
    }
    // 割合にそろえる。メガストーンは別枠で megaRate
    const itemTotal = [...items.values()].reduce((a, b) => a + b, 0);
    const itemList = [...items.entries()].map(([item, v]) => ({ item, w: (megas.length ? 1 - megaRate : 1) * v / itemTotal }));
    for (const ms of megas) itemList.push({ item: ms, w: megaRate / megas.length });
    const spreadTotal = [...spreads.values()].reduce((a, b) => a + b, 0);
    return {
      role: r.role, pool: r.pool, abilities: r.abilities,
      items: itemList,
      spreads: [...spreads.entries()].map(([k, v]) => ({ ...JSON.parse(k), w: v / spreadTotal })),
    };
  });
  out[sp.id] = { name: sp.name, seedCount: n, otherWeight: 1 / (n + 1), seed, generic };
}
mkdirSync(resolve(ROOT, 'data/priors'), { recursive: true });
writeFileSync(resolve(ROOT, 'data/priors/sets.json'), JSON.stringify({
  source: `data/seed/teams_m7.json と Showdown ${showdownCommit()} の data/random-battles/champions/sets.json から tools/gen-priors.ts で作成`,
  megaRate, species: out,
}));
console.log(`種族 ${legalSpecies.length}（上位構築に出る ${seedBySpecies.size}、Showdown の型データがない ${noRandom}）、メガストーンを持つ割合 ${megaRate.toFixed(3)}`);
