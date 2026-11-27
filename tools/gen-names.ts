// 日本語名の表（data/names/ja.json）を作る。
// もと：PokeAPI（https://github.com/PokeAPI/pokeapi、BSD 3条項ライセンス）の CSV の、言語番号1（ja-hrkt、ゲーム画面と同じかな表記）。
//       決めたコミットに固定して取得する（.build/pokeapi に置く。リポジトリには入れない）。
// 足りない名前：data/names/manual.json（根拠つきで手で足したもの）。推測では足さない。
// 対象：Showdown の図鑑で、チャンピオンズ（gen9championsbssregmc）で使えるもの。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadShowdown, FORMAT, ROOT } from './showdown/load.ts';

const POKEAPI_COMMIT = 'de6760be38b60a3024f1d9054330ff265f0dc619';
const DIR = resolve(ROOT, '.build/pokeapi', POKEAPI_COMMIT);
const FILES = ['pokemon_species', 'pokemon_species_names', 'pokemon', 'pokemon_forms', 'pokemon_form_names', 'moves', 'move_names', 'items', 'item_names', 'abilities', 'ability_names', 'natures', 'nature_names', 'types', 'type_names'];
mkdirSync(DIR, { recursive: true });
for (const f of FILES) {
  const p = resolve(DIR, `${f}.csv`);
  if (existsSync(p)) continue;
  const res = await fetch(`https://raw.githubusercontent.com/PokeAPI/pokeapi/${POKEAPI_COMMIT}/data/v2/csv/${f}.csv`);
  if (!res.ok) throw new Error(`${f}.csv を取得できない（${res.status}）`);
  writeFileSync(p, await res.text());
}
function csv(name: string): Record<string, string>[] {
  const lines = readFileSync(resolve(DIR, `${name}.csv`), 'utf8').split(/\r?\n/).filter(Boolean);
  const head = lines[0].split(',');
  return lines.slice(1).map(l => {
    // 名前に , を含む行は "" で囲まれている
    const cells: string[] = []; let cur = '', q = false;
    for (const ch of l) { if (ch === '"') q = !q; else if (ch === ',' && !q) { cells.push(cur); cur = ''; } else cur += ch; }
    cells.push(cur);
    return Object.fromEntries(head.map((h, i) => [h, cells[i] ?? '']));
  });
}
const toID = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const JA = '1';
// identifier → 日本語名
function names(base: string, namesFile: string, key: string, nameCol = 'name') {
  const byId = new Map(csv(base).map(r => [r.id, r.identifier]));
  const out = new Map<string, string>();
  for (const r of csv(namesFile)) if (r.local_language_id === JA && r[nameCol]) out.set(toID(byId.get(r[key]) ?? ''), r[nameCol]);
  return out;
}
const pkSpecies = names('pokemon_species', 'pokemon_species_names', 'pokemon_species_id');
const pkMoves = names('moves', 'move_names', 'move_id');
const pkItems = names('items', 'item_names', 'item_id');
const pkAbilities = names('abilities', 'ability_names', 'ability_id');
const pkNatures = names('natures', 'nature_names', 'nature_id');
const pkTypes = names('types', 'type_names', 'type_id');
// 姿の違い（ヒートロトム、ガラルヤドキング、メガ○○など）：pokemon_form_names
// 日本語では完全な名前が form_name に入っていることが多い（例：メガガブリアス、ヒートロトム）。
// 「ガラルのすがた」のように姿の名前だけのときは「ヤドキング（ガラルのすがた）」にする。
const formRows = csv('pokemon_forms');
const formIdent = new Map(formRows.map(r => [r.id, r.identifier]));
const speciesOfPokemon = new Map(csv('pokemon').map(r => [r.id, r.species_id]));
const speciesIdent = new Map(csv('pokemon_species').map(r => [r.id, r.identifier]));
const formSpecies = new Map(formRows.map(r => [r.id, speciesIdent.get(speciesOfPokemon.get(r.pokemon_id) ?? '') ?? '']));
const pkForms = new Map<string, string>();
for (const r of csv('pokemon_form_names')) {
  if (r.local_language_id !== JA) continue;
  const baseJa = pkSpecies.get(toID(formSpecies.get(r.pokemon_form_id) ?? '')) ?? '';
  let v = r.pokemon_name;
  if (!v && r.form_name) v = r.form_name.endsWith('すがた') || r.form_name.endsWith('フォルム') || r.form_name.endsWith('しゅ') ? `${baseJa}（${r.form_name}）` : r.form_name;
  if (v) pkForms.set(toID(formIdent.get(r.pokemon_form_id) ?? ''), v);
}
// Showdown と PokeAPI で姿の呼び方が違うもの
const FORM_ALIAS: Record<string, string> = {
  taurospaldeacombat: 'taurospaldeacombatbreed', taurospaldeablaze: 'taurospaldeablazebreed', taurospaldeaaqua: 'taurospaldeaaquabreed',
};

const manualPath = resolve(ROOT, 'data/names/manual.json');
const manual = existsSync(manualPath) ? JSON.parse(readFileSync(manualPath, 'utf8')) : { species: {}, moves: {}, items: {}, abilities: {}, natures: {}, types: {} };

const PS = loadShowdown();
const dex = PS.Dex.forFormat(FORMAT);
const legal = (x: any) => x.exists && !x.isNonstandard;
const out: Record<string, Record<string, string>> = { species: {}, moves: {}, items: {}, abilities: {}, natures: {}, types: {} };
const missing: Record<string, string[]> = { species: [], moves: [], items: [], abilities: [], natures: [], types: [] };
const put = (kind: string, id: string, en: string, ...cands: (string | undefined)[]) => {
  const m = manual[kind]?.[id]?.ja;
  const v = m ?? cands.find(Boolean);
  if (v) out[kind][id] = v; else missing[kind].push(`${id}（${en}）`);
};
// 使える持ち物でなれるメガシンカの姿
const megaFormes = new Set<string>();
for (const it of dex.items.all()) if (legal(it) && it.megaStone) for (const f of Object.values(it.megaStone) as string[]) megaFormes.add(toID(f));
const REGION: Record<string, string> = { Alola: 'アローラ', Galar: 'ガラル', Hisui: 'ヒスイ', Paldea: 'パルデア' };
const aliases: Record<string, string[]> = {};
for (const s of dex.species.all()) {
  if (!s.exists) continue;
  if (s.isNonstandard ? !megaFormes.has(s.id) : false) continue;
  const formJa = pkForms.get(FORM_ALIAS[s.id] ?? s.id);
  const baseJa = pkSpecies.get(toID(s.baseSpecies));
  // 地方の姿は、上位構築のデータと同じ「ガラルヤドキング」の書き方にする（PokeAPI の書き方は別名として残す）
  const region = Object.keys(REGION).find(r => s.forme === r || s.forme?.startsWith(r + '-'));
  let disp = formJa;
  if (region && baseJa && !manual.species?.[s.id]) {
    disp = REGION[region] + baseJa;
    if (formJa && formJa !== disp) (aliases[s.id] ??= []).push(formJa);
  }
  const before = missing.species.length;
  put('species', s.id, s.name, disp, s.forme ? undefined : baseJa);
  if (missing.species.length > before && baseJa && s.forme) {
    // 見た目だけの違いや戦闘中だけの姿：基本の日本語名＋（姿の英語名）で表示する（日本語の姿の名前は未確認）
    out.species[s.id] = `${baseJa}（${s.forme}）`;
  }
}
for (const m of dex.moves.all()) if (legal(m)) put('moves', m.id, m.name, pkMoves.get(m.id));
for (const it of dex.items.all()) if (legal(it)) put('items', it.id, it.name, pkItems.get(it.id));
for (const a of dex.abilities.all()) if (legal(a)) put('abilities', a.id, a.name, pkAbilities.get(a.id));
for (const n of dex.natures.all()) put('natures', n.id, n.name, pkNatures.get(n.id));
for (const t of dex.types.all()) if (t.exists && !t.isNonstandard) put('types', t.id, t.name, pkTypes.get(t.id));

// 同じ表示名が重なる姿（例：パルデアケンタロス3種）は、姿の英語名を付けて区別する
{
  const count = new Map<string, number>();
  for (const v of Object.values(out.species)) count.set(v, (count.get(v) ?? 0) + 1);
  for (const [id, v] of Object.entries(out.species)) if ((count.get(v) ?? 0) > 1) {
    const sp = dex.species.get(id);
    out.species[id] = `${v}（${sp.forme}）`;
    (aliases[id] ??= []).push(v);
  }
}
// 手で足した別名
for (const [id, v] of Object.entries(manual.species ?? {}) as [string, any][]) if (v.aliases) (aliases[id] ??= []).push(...v.aliases);
writeFileSync(resolve(ROOT, 'data/names/ja.json'), JSON.stringify({ source: `PokeAPI ${POKEAPI_COMMIT}（ja-hrkt）＋ data/names/manual.json`, ...out, speciesAliases: aliases }, null, 1));
for (const [k, v] of Object.entries(out)) console.log(`${k}：${Object.keys(v).length} 件、足りない ${missing[k].length} 件`);
writeFileSync(resolve(ROOT, '.build/names-missing.json'), JSON.stringify(missing, null, 1));
