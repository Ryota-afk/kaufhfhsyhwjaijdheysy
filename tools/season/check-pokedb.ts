// バトルデータベースの公開データ（M-7）を直したものを、今の teams_m7.json と同じ順位で比べる。
import { readFileSync } from 'node:fs';
import { convertSeason } from './pokedb.ts';
const toID = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const ja = JSON.parse(readFileSync('data/names/ja.json', 'utf8'));
const c = convertSeason(JSON.parse(readFileSync('data/season/raw/pokedb_s7_single.json', 'utf8')), ja);
console.log(`${c.season}：構築 ${c.teams.length}、直せなかった名前 ${c.unresolved.length}`, c.unresolved);
const seed = new Map(JSON.parse(readFileSync('data/seed/teams_m7.json', 'utf8')).map((t: any) => [t.rank, t]));
let n = 0, lineup = 0, monItems = 0, monItemsSame = 0;
for (const t of c.teams) {
  const s: any = seed.get(t.rank); if (!s) continue;
  n++;
  const a = t.mons.map(m => m.species).sort().join(','), b = s.mons.map((m: any) => toID(m.species)).sort().join(',');
  if (a === b) lineup++; else console.log(`違う ${t.rank}位：公開データ ${a} ／ 今 ${b}`);
  for (const m of t.mons) { const sm = s.mons.find((x: any) => toID(x.species) === m.species); if (!sm) continue; monItems++; if (toID(sm.item) === m.item) monItemsSame++; }
}
console.log(`同じ順位の構築 ${n}、6体が一致 ${lineup}。同じ体の持ち物 ${monItems} のうち一致 ${monItemsSame}`);
