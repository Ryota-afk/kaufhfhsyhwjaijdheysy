// 新しいシーズンの上位構築を取り込み、data/seed/teams_m{n}.json を作る（指示文 4-6.、docs/season-import.md）。
//  1. 6体・持ち物・順位：バトルデータベース チャンピオンズの公開データ（1シーズン1回取得）
//  2. 技・特性・性格・能力ポイントの補い（利用者が決めた順番）：
//     ① 前のシーズンまでの実際の型（記事から取ったもの。補った型は使わない）で、同じ種族・同じ持ち物のもの
//     ② Smogon の統計（メガストーンを持つときは、そのメガシンカ後の姿の統計）
//     ③ Showdown の型データ（data/random-battles/champions/sets.json）
//     補った項目は fill に出どころを書く。記事のURL・記事ごとの選出はない（取り込み元にないため）。
// 使い方：
//   npx tsx tools/season/import.ts --auto              … 次のシーズンの公開データがあれば取り込む（裏の計算で週1回）
//   npx tsx tools/season/import.ts --season 8          … シーズン8を取り込む
//   npx tsx tools/season/import.ts --test 7            … 確かめ：M-7 を新しいシーズンとみなして補い、今の teams_m7.json と比べる
//                                                        （①は M-7 の、その構築を除いた型を使う。同じシーズンなので甘めの値）
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { loadShowdown, FORMAT } from '../showdown/load.ts';
import { convertSeason, fetchSeasonOnce } from './pokedb.ts';
import { loadSmogon, fetchLatestSmogon, topKeys, parseSpread, type SmogonSpecies } from './smogon.ts';

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? (process.argv[i + 1] ?? '') : null; };
const toID = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const PS = loadShowdown();
const dex = PS.Dex.forFormat(FORMAT);
const validator = PS.TeamValidator.get(FORMAT);
const ja = JSON.parse(readFileSync('data/names/ja.json', 'utf8'));
const randomSets = JSON.parse(readFileSync('vendor/showdown/data/random-battles/champions/sets.json', 'utf8'));
const current = JSON.parse(readFileSync('data/season/current.json', 'utf8'));
const testSeason = arg('test') !== null ? Number(arg('test')) : null;
let seasonNo = testSeason ?? (arg('season') !== null ? Number(arg('season')) : current.seasonNumber + 1);

// 前のシーズンまでの実際の型（fill のない体だけ）
const realTeams: { file: string; teams: any[] }[] = [current.teams, ...current.previous].filter((f: string) => existsSync(f)).map((f: string) => ({ file: f, teams: JSON.parse(readFileSync(f, 'utf8')) }));

const raw = await fetchSeasonOnce(seasonNo);
if (!raw) { console.log(`シーズン${seasonNo}の公開データはまだありません`); process.exit(0); }
if (testSeason === null && arg('auto') !== null && existsSync(`data/seed/teams_m${seasonNo}.json`)) { console.log(`シーズン${seasonNo}は取り込み済み`); process.exit(0); }
const conv = convertSeason(raw, ja);
if (conv.unresolved.length) console.log('直せなかった名前（その体は取り込まない）：', conv.unresolved);
const smogonFile = testSeason !== null || process.env.SEASON_DRYRUN ? current.smogon : await fetchLatestSmogon();
const smogon = loadSmogon(smogonFile);
console.log(`${conv.season}：構築 ${conv.teams.length}。Smogon の統計 ${smogonFile}`);

const nameOf = { species: (id: string) => dex.species.get(id).name, item: (id: string) => id ? dex.items.get(id).name : '', ability: (id: string) => dex.abilities.get(id).name, move: (id: string) => dex.moves.get(id).name };
const STATS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const;
const most = <T,>(xs: T[], key: (x: T) => string): T | undefined => { const c = new Map<string, { x: T; n: number }>(); for (const x of xs) { const k = key(x); const e = c.get(k) ?? { x, n: 0 }; e.n++; c.set(k, e); } return [...c.values()].sort((a, b) => b.n - a.n)[0]?.x; };

/** 1体の型を補う。exclude：確かめのとき、同じ構築（順位）の型を①から除く。 */
function fill(speciesId: string, itemId: string, exclude: { file: string; rank: number } | null) {
  const sp = dex.species.get(speciesId);
  // ① 前のシーズンまでの実際の型（同じ種族・同じ持ち物）
  const real = realTeams.flatMap(r => r.teams.filter(t => !(exclude && r.file === exclude.file && t.rank === exclude.rank)).flatMap((t: any) => t.mons))
    .filter((m: any) => !m.fill && toID(m.species) === speciesId && toID(m.item) === itemId);
  if (real.length) {
    const spread = most(real, (m: any) => JSON.stringify([toID(m.nature), m.evs]))!;
    const mc = new Map<string, number>(); for (const m of real) for (const mv of m.moves) mc.set(toID(mv), (mc.get(toID(mv)) ?? 0) + 1);
    const ability = most(real.filter((m: any) => m.ability), (m: any) => toID(m.ability));
    return { ability: ability ? toID(ability.ability) : toID(sp.abilities['0']), nature: spread.nature, evs: spread.evs, moves: [...mc].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k]) => k), src: 'prev' as const, n: real.length };
  }
  // ② Smogon の統計
  const s: SmogonSpecies | undefined = smogon.get(speciesId) ?? smogon.get(toID(sp.baseSpecies));
  if (s && s.count > 0) {
    const part = dex.items.get(itemId).megaStone && s.byItem[itemId] ? s.byItem[itemId] : { moves: s.moves, spreads: s.spreads };
    const legalAb = new Set((Object.values(sp.abilities) as string[]).map(toID));
    const ability = topKeys(s.abilities, 5).find(a => legalAb.has(a)) ?? toID(sp.abilities['0']);
    const spread = parseSpread(topKeys(part.spreads, 1)[0] ?? 'Hardy:0/0/0/0/0/0');
    return { ability, nature: spread.nature, evs: spread.evs, moves: topKeys(part.moves, 4), src: 'smogon' as const, n: Math.round(s.count) };
  }
  // ③ Showdown の型データ（最初の役割の技の候補の先頭4つ）
  const rs = randomSets[speciesId] ?? randomSets[toID(sp.baseSpecies)];
  const role = rs?.sets?.[0];
  return { ability: toID(role?.abilities?.[0] ?? sp.abilities['0']), nature: 'Hardy', evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }, moves: (role?.movepool ?? []).slice(0, 4).map(toID), src: 'showdown' as const, n: 0 };
}

const teamsOut: any[] = [];
const srcCount = { prev: 0, smogon: 0, showdown: 0 };
let invalid = 0; const invalidSamples: string[] = [];
const seedFile = `data/seed/teams_m${seasonNo}.json`;
for (const t of conv.teams) {
  if (t.mons.some(m => !m.species)) continue;
  const mons = t.mons.map(m => {
    const f = fill(m.species!, m.item, testSeason !== null ? { file: current.teams, rank: t.rank } : null);
    srcCount[f.src]++;
    return {
      species: nameOf.species(m.species!), jp: ja.species[m.species!] ?? m.jpName, item: nameOf.item(m.item),
      ability: nameOf.ability(f.ability), nature: f.nature.charAt(0).toUpperCase() + f.nature.slice(1),
      evs: Object.fromEntries(STATS.map(k => [k, (f.evs as any)[k] ?? 0])), moves: f.moves.map(nameOf.move),
      fill: { ability: f.src, nature: f.src, evs: f.src, moves: f.src, basis: f.n },
    };
  });
  const problems = validator.validateTeam(mons.map((m: any) => ({ ...m, name: '', level: 50, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 } })));
  if (problems) { invalid++; if (invalidSamples.length < 5) invalidSamples.push(`${t.rank}位：${problems.slice(0, 2).join(' / ')}`); }
  teamsOut.push({ rank: t.rank, season: conv.season, rating: t.rating, article_url: '', source: 'champs.pokedb.tokyo 公開データ＋補い', mons });
}
const total = srcCount.prev + srcCount.smogon + srcCount.showdown;
console.log(`補いの出どころ：①前のシーズンの実際の型 ${srcCount.prev}、②Smogon ${srcCount.smogon}、③Showdown の型データ ${srcCount.showdown}（計 ${total} 体）`);
console.log(`Showdown の検査を通らない構築 ${invalid}/${teamsOut.length}`, invalidSamples);

if (testSeason !== null) {
  // 確かめ：今の teams_m7.json（実際の型）と比べる
  const seed = new Map(JSON.parse(readFileSync(current.teams, 'utf8')).map((t: any) => [t.rank, t]));
  const acc: Record<string, { n: number; ability: number; nature: number; evs: number; moves: number }> = {};
  for (const t of teamsOut) {
    const s: any = seed.get(t.rank); if (!s) continue;
    for (const m of t.mons) {
      const r = s.mons.find((x: any) => toID(x.species) === toID(m.species) && toID(x.item) === toID(m.item)); if (!r) continue;
      const a = acc[m.fill.moves] ??= { n: 0, ability: 0, nature: 0, evs: 0, moves: 0 };
      a.n++;
      if (toID(r.ability) === toID(m.ability)) a.ability++;
      if (toID(r.nature) === toID(m.nature)) a.nature++;
      if (JSON.stringify(STATS.map(k => r.evs[k])) === JSON.stringify(STATS.map(k => m.evs[k]))) a.evs++;
      const rm = new Set(r.moves.map(toID)); a.moves += m.moves.filter((x: string) => rm.has(toID(x))).length;
    }
  }
  for (const [src, a] of Object.entries(acc)) console.log(`確かめ（${src}、${a.n}体）：特性 ${(a.ability / a.n * 100).toFixed(0)}%、性格 ${(a.nature / a.n * 100).toFixed(0)}%、能力ポイントが完全に同じ ${(a.evs / a.n * 100).toFixed(0)}%、技4つのうち ${(a.moves / a.n).toFixed(2)}個`);
  writeFileSync('.build/import-test.json', JSON.stringify(teamsOut, null, 1));
} else {
  writeFileSync(seedFile, JSON.stringify(teamsOut, null, 1));
  // 今のシーズンを新しいシーズンにし、前のシーズンを previous に回す
  const next = { ...current, season: conv.season, seasonNumber: seasonNo, teams: seedFile, previous: [current.teams, ...current.previous], smogon: smogonFile };
  writeFileSync('data/season/current.json', JSON.stringify(next, null, 1) + '\n');
  console.log(`書き出し：${seedFile}、data/season/current.json`);
}
