// Smogon の統計（https://www.smogon.com/stats/ の chaos JSON）を種族ごとにまとめる。
// 統計では、メガストーンを持つ型が「Garchomp-Mega-Z」のようにメガシンカ後の姿で別に数えられているので、もとの種族に足し合わせる。
// 特性は、メガシンカ後の姿の分は数えない（メガシンカ後の特性で数えられているため）。
// 取得：利用者の判断で補いに使う（docs/season-import.md）。1か月分のファイルを1回だけ取得して data/season/raw/ に置く。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const toID = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
export const SMOGON_FORMAT = 'gen9championsbssregmc', SMOGON_CUTOFF = 1760;

export interface SmogonSpecies {
  count: number;                                  // ポケモンの数（重みつき）
  items: Record<string, number>;                  // 持ち物 id → 重み
  abilities: Record<string, number>;              // 特性 id → 重み（メガシンカしていない姿の分だけ）
  spreads: Record<string, number>;                // 「性格:hp/atk/def/spa/spd/spe」→ 重み
  moves: Record<string, number>;                  // 技 id → 重み（ポケモンの数で割ると採用率）
  byItem: Record<string, { moves: Record<string, number>; spreads: Record<string, number>; count: number }>;   // メガストーンごとの技と能力ポイント
}

export function loadSmogon(file: string): Map<string, SmogonSpecies> {
  const d = JSON.parse(readFileSync(file, 'utf8'));
  const out = new Map<string, SmogonSpecies>();
  const add = (a: Record<string, number>, b: Record<string, number>) => { for (const [k, v] of Object.entries(b)) if (k) a[k] = (a[k] ?? 0) + v; };
  for (const [name, v] of Object.entries(d.data) as [string, any][]) {
    const mega = name.includes('-Mega');
    const id = toID(name.split('-Mega')[0]);
    const cur = out.get(id) ?? { count: 0, items: {}, abilities: {}, spreads: {}, moves: {}, byItem: {} };
    const count = Object.values(v.Abilities as Record<string, number>).reduce((a, b) => a + b, 0);
    cur.count += count;
    add(cur.items, v.Items); add(cur.spreads, v.Spreads); add(cur.moves, v.Moves);
    if (!mega) add(cur.abilities, v.Abilities);
    else {
      // メガシンカ後の姿の分は、その姿のメガストーン（いちばん多い持ち物）ごとに技と能力ポイントを持つ
      const stone = Object.entries(v.Items as Record<string, number>).sort((a, b) => b[1] - a[1])[0]?.[0];
      if (stone) { const b = cur.byItem[stone] ?? { moves: {}, spreads: {}, count: 0 }; add(b.moves, v.Moves); add(b.spreads, v.Spreads); b.count += count; cur.byItem[stone] = b; }
    }
    out.set(id, cur);
  }
  return out;
}

export const topKeys = (o: Record<string, number>, n: number) => Object.entries(o).filter(([k]) => k && k !== 'nothing').sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
export function parseSpread(key: string) {
  const [nature, ev] = key.split(':');
  const v = ev.split('/').map(Number);
  return { nature, evs: { hp: v[0], atk: v[1], def: v[2], spa: v[3], spd: v[4], spe: v[5] } };
}

/** いちばん新しい月の統計を、まだ持っていなければ1回だけ取得する。月の一覧の取得1回＋ファイル1回。 */
export async function fetchLatestSmogon(dir = 'data/season/raw'): Promise<string> {
  const idx = await (await fetch('https://www.smogon.com/stats/')).text();
  const months = [...idx.matchAll(/href="(\d{4}-\d{2})\/"/g)].map(m => m[1]).sort();
  // 新しい月から3か月分まで見る（形式がなくなった月が続いても、取りに行く回数を増やさない）
  for (const month of months.reverse().slice(0, 3)) {
    const file = `${dir}/smogon_${month}_${SMOGON_FORMAT}-${SMOGON_CUTOFF}.json`;
    if (existsSync(file)) return file;
    const r = await fetch(`https://www.smogon.com/stats/${month}/chaos/${SMOGON_FORMAT}-${SMOGON_CUTOFF}.json`);
    if (r.status === 404) continue;
    if (!r.ok) throw new Error(`Smogon の統計を取得できませんでした：${month} ${r.status}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, await r.text());
    return file;
  }
  throw new Error('Smogon の統計に、チャンピオンズのシングルの月がありません');
}
