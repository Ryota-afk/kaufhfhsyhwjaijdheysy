// バトルデータベース チャンピオンズ（https://champs.pokedb.tokyo/）の上位構築の公開データを、このサイトの形に直す。
// 公開データの案内（https://champs.pokedb.tokyo/guide/opendata）：「プログラムなどを利用してデータをダウンロードすることは可能」、
// 「ご自身のサーバーにファイルを一度ダウンロードしてから利用」。そのため、シーズンごとに1回だけ取得し、data/season/raw/ に置いて使う。
// 中身は順位・レート・6体の種族と姿・持ち物だけ（技・特性・性格・能力ポイント・記事のURLはない）。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const kata = (s: string) => s.normalize('NFKC').replace(/[ぁ-ゖ]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60)).replace(/[\s　]/g, '');

export interface DbMon { id: string; pokemon: string; form: string; item: string }
export interface DbTeam { rank: number; rating_value: number; team: DbMon[] }
export interface DbSeason { season: string; season_number: number; rule: string; teams: DbTeam[]; updated_at: string }

/** 日本語名の表（data/names/ja.json）から、名前 → Showdown の id の引き方を作る。 */
export function makeNameLookup(ja: any) {
  const species = new Map<string, string>(), items = new Map<string, string>();
  for (const [id, name] of Object.entries(ja.species as Record<string, string | null>)) if (name) species.set(kata(name), id);
  for (const [id, names] of Object.entries((ja.speciesAliases ?? {}) as Record<string, string[]>)) for (const n of names) if (!species.has(kata(n))) species.set(kata(n), id);
  for (const [id, name] of Object.entries(ja.items as Record<string, string | null>)) if (name) items.set(kata(name), id);
  // 出どころで表記が違う持ち物（どちらが正式かは確認していない。取り込みのときだけ同じ持ち物として読む）
  //   スターミナイト：バトルデータベース（M-7 の公開データ）。表の名前「スターミーナイト」はゲームエイト由来
  for (const [alias, id] of Object.entries({ スターミナイト: 'starminite' })) if (!items.has(kata(alias))) items.set(kata(alias), id);
  // パルデアケンタロスの3つの姿は、姿の名前の種で分ける
  const tauros: Record<string, string> = { コンバット: 'taurospaldeacombat', ブレイズ: 'taurospaldeablaze', ウォーター: 'taurospaldeaaqua' };
  const speciesOf = (m: DbMon): string | null => {
    if (kata(m.pokemon) === kata('ケンタロス') && m.form) for (const [k, id] of Object.entries(tauros)) if (kata(m.form).includes(kata(k))) return id;
    const cands = m.form ? [m.form, `${m.pokemon}（${m.form}）`, `${m.form}${m.pokemon}`] : [m.pokemon];
    // メスの姿（イエッサン・イダイトウ等）は「種族名（メス）」
    if (m.form && /メス/.test(m.form)) cands.unshift(`${m.pokemon}（メス）`);
    for (const c of cands) { const id = species.get(kata(c)); if (id) return id; }
    // 普通の姿にも姿の名前がついている（ばけたすがた、シールドフォルム、オスのすがた等）。表にない姿の名前なら、種族名で引く
    if (m.form) { const id = species.get(kata(m.pokemon)); if (id) return id; }
    return null;
  };
  const itemOf = (name: string): string | null => name ? items.get(kata(name)) ?? null : '';
  return { speciesOf, itemOf };
}

/** 公開データ1シーズン分を、順位・6体（Showdown の id）・持ち物に直す。直せなかった名前は unresolved に入れる。 */
export function convertSeason(d: DbSeason, ja: any) {
  const { speciesOf, itemOf } = makeNameLookup(ja);
  const unresolved: string[] = [];
  const teams = d.teams.map(t => ({
    rank: t.rank, rating: t.rating_value,
    mons: t.team.map(m => {
      const species = speciesOf(m), item = itemOf(m.item);
      if (!species) unresolved.push(`種族：${m.pokemon}${m.form ? `（${m.form}）` : ''}`);
      if (item === null) unresolved.push(`持ち物：${m.item}`);
      return { species, item: item || '', jpName: m.form || m.pokemon, jpItem: m.item };
    }),
  }));
  return { season: d.season, seasonNumber: d.season_number, updatedAt: d.updated_at, teams, unresolved: [...new Set(unresolved)] };
}

/** シーズン n のシングルのファイルを、まだ持っていなければ1回だけ取得して data/season/raw/ に置く。なければ null。 */
export async function fetchSeasonOnce(n: number, dir = 'data/season/raw'): Promise<DbSeason | null> {
  const file = `${dir}/pokedb_s${n}_single.json`;
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const url = `https://champs.pokedb.tokyo/opendata/s${n}_single_ranked_teams.json`;
  const r = await fetch(url);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`取得できませんでした：${url} ${r.status}`);
  const d = await r.json() as DbSeason;
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(d));
  return d;
}
