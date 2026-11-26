// Showdown（Champions 用の変更を当てた後）のデータから、エンジン用のデータを書き出す。
// 出力：src/engine/data/dex.json
// 関数（特別な処理）はそのまま写せないので、関数の名前の一覧だけを残す（エンジンの対応状況の点検に使う）。
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadShowdown, ROOT, FORMAT, showdownCommit } from './showdown/load.ts';

const PS = loadShowdown();
const dex = PS.Dex.forFormat(FORMAT);

function fnNames(obj: any, prefix = ''): string[] {
  const out: string[] = [];
  if (!obj) return out;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (typeof v === 'function') out.push(prefix + k);
  }
  return out.sort();
}
function plain(v: any): any {
  if (v === undefined || typeof v === 'function') return undefined;
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === 'object') {
    const o: any = {};
    for (const k of Object.keys(v)) { const p = plain(v[k]); if (p !== undefined) o[k] = p; }
    return o;
  }
  return v;
}

const MOVE_KEYS = ['num', 'name', 'type', 'category', 'basePower', 'accuracy', 'priority', 'pp', 'noPPBoosts', 'flags', 'target',
  'secondary', 'secondaries', 'self', 'boosts', 'selfBoost', 'status', 'volatileStatus', 'sideCondition', 'slotCondition',
  'weather', 'terrain', 'pseudoWeather', 'drain', 'recoil', 'heal', 'multihit', 'multihitType', 'multiaccuracy', 'critRatio',
  'willCrit', 'forceSwitch', 'selfSwitch', 'selfdestruct', 'ohko', 'ignoreImmunity', 'ignoreAbility', 'ignoreDefensive',
  'ignoreEvasion', 'ignoreAccuracy', 'breaksProtect', 'stallingMove', 'overrideOffensiveStat', 'overrideOffensivePokemon',
  'overrideDefensiveStat', 'struggleRecoil', 'hasCrashDamage', 'mindBlownRecoil', 'thawsTarget', 'sleepUsable', 'damage',
  'tracksTarget', 'smartTarget', 'nonGhostTarget', 'isZ', 'isMax', 'hasSheerForce', 'stealsBoosts', 'basePowerCallback'];

const legal = (x: any) => x.exists && !x.isNonstandard;

const moves: Record<string, any> = {};
for (const m of dex.moves.all()) {
  if (!legal(m) && m.id !== 'struggle') continue;
  const o: any = {};
  for (const k of MOVE_KEYS) if (k !== 'basePowerCallback') { const p = plain((m as any)[k]); if (p !== undefined) o[k] = p; }
  o.fn = fnNames(m);
  if (m.condition) { o.condition = plain(m.condition); o.conditionFn = fnNames(m.condition); }
  moves[m.id] = o;
}

const items: Record<string, any> = {};
for (const it of dex.items.all()) {
  if (!legal(it)) continue;
  items[it.id] = {
    num: it.num, name: it.name, megaStone: plain(it.megaStone), isBerry: !!it.isBerry, fling: plain(it.fling),
    naturalGift: plain(it.naturalGift), isChoice: !!it.isChoice, ignoreKlutz: !!it.ignoreKlutz, boosts: plain(it.boosts),
    fn: fnNames(it), condition: it.condition ? plain(it.condition) : undefined, conditionFn: it.condition ? fnNames(it.condition) : undefined,
    priority: plain(Object.fromEntries(Object.entries(it).filter(([k, v]) => /Priority$|Order$|SubOrder$/.test(k) && typeof v === 'number'))),
  };
}

const abilities: Record<string, any> = {};
for (const a of dex.abilities.all()) {
  if (!legal(a)) continue;
  abilities[a.id] = {
    num: a.num, name: a.name, flags: plain(a.flags), fn: fnNames(a),
    condition: a.condition ? plain(a.condition) : undefined, conditionFn: a.condition ? fnNames(a.condition) : undefined,
    priority: plain(Object.fromEntries(Object.entries(a).filter(([k, v]) => /Priority$|Order$|SubOrder$/.test(k) && typeof v === 'number'))),
  };
}

const species: Record<string, any> = {};
for (const s of dex.species.all()) {
  if (!s.exists) continue;
  if (s.isNonstandard && !(s.isMega)) continue;
  species[s.id] = {
    num: s.num, name: s.name, baseSpecies: s.baseSpecies, forme: s.forme, types: s.types, baseStats: s.baseStats,
    abilities: s.abilities, weightkg: s.weightkg, isMega: !!s.isMega, requiredItem: s.requiredItem, otherFormes: s.otherFormes,
    nonstandard: s.isNonstandard || null,
  };
}

const types: Record<string, Record<string, number>> = {};
for (const t of dex.types.all()) {
  if (!t.exists || t.isNonstandard) continue;
  types[t.name] = { ...t.damageTaken };
}

const natures: Record<string, { plus?: string; minus?: string }> = {};
for (const n of dex.natures.all()) natures[n.name] = { plus: n.plus, minus: n.minus };

const out = { format: FORMAT, showdownCommit: showdownCommit(), moves, items, abilities, species, types, natures };
writeFileSync(resolve(ROOT, 'src/engine/data/dex.json'), JSON.stringify(out));
console.log(`技 ${Object.keys(moves).length}、持ち物 ${Object.keys(items).length}、特性 ${Object.keys(abilities).length}、種族 ${Object.keys(species).length}、タイプ ${Object.keys(types).length}`);
