// 開発用：使う効果が Showdown のどのイベントに、どの優先度で処理を付けているかの一覧を .build/dev-events.txt に書く。
import { readFileSync, writeFileSync } from 'node:fs';
import { loadShowdown, FORMAT } from '../showdown/load.ts';
const PS = loadShowdown(); const dex = PS.Dex.forFormat(FORMAT);
const teams = JSON.parse(readFileSync('data/seed/teams_m7.json', 'utf8'));
const id = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const effects: [string, any][] = [];
const seen = new Set<string>();
const add = (kind: string, e: any) => { if (!e?.exists && !e) return; const k = kind + ':' + e.id; if (seen.has(k)) return; seen.add(k); effects.push([k, e]); };
for (const t of teams) for (const m of t.mons) {
  for (const mv of m.moves) { const x = dex.moves.get(mv); add('move', x); if (x.condition) add('movecond', { ...x.condition, id: x.id }); }
  const it = dex.items.get(m.item); add('item', it);
  if (m.ability) add('ability', dex.abilities.get(m.ability));
  if (it.megaStone) for (const f of Object.values(it.megaStone) as string[]) add('ability', dex.abilities.get(dex.species.get(f).abilities[0]));
}
for (const c of ['brn','par','psn','tox','slp','frz','confusion','flinch','trapped','partiallytrapped','lockedmove','twoturnmove','choicelock','mustrecharge','futuremove','healreplacement','stall','gem','raindance','sunnyday','sandstorm','snowscape','primordialsea','desolateland','deltastream','electricterrain','grassyterrain','psychicterrain','mistyterrain','dynamax','commanded','commanding','rolloutstorage','arceus','silvally']) {
  const x = dex.conditions.get(c); if (x?.exists) add('cond', x);
}
const ev: Record<string, string[]> = {};
for (const [k, e] of effects) {
  for (const key of Object.keys(e)) {
    if (!key.startsWith('on') || typeof e[key] !== 'function') continue;
    const pr = e[key + 'Priority'], ord = e[key + 'Order'], sub = e[key + 'SubOrder'];
    const name = key.replace(/^on(Ally|Foe|Source|Any|Side|Field)?/, '');
    (ev[name] ??= []).push(`${k}.${key}${pr !== undefined ? ' p=' + pr : ''}${ord !== undefined ? ' o=' + ord : ''}${sub !== undefined ? ' s=' + sub : ''}`);
  }
}
const lines = Object.keys(ev).sort().map(n => `## ${n}\n` + ev[n].join('\n'));
writeFileSync('.build/dev-events.txt', lines.join('\n\n'));
console.log(Object.keys(ev).length, 'events');
