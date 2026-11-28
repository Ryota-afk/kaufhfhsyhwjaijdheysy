// 初期データ（data/seed/）を Showdown の検査にかけ、結果を docs/seed-check.md に書く。
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadShowdown, ROOT, FORMAT, showdownCommit } from './showdown/load.ts';
import type { SeedTeam } from '../src/engine/seed-types.ts';

const PS = loadShowdown();
const teams: SeedTeam[] = JSON.parse(readFileSync(resolve(ROOT, 'data/seed/teams_m7.json'), 'utf8'));
const selections: any[] = JSON.parse(readFileSync(resolve(ROOT, 'data/seed/selections_m7.json'), 'utf8'));
const validator = PS.TeamValidator.get(FORMAT);

const lines: string[] = [];
lines.push('# 初期データの点検結果', '');
lines.push(`Showdown のコミット ${showdownCommit()}、形式 ${FORMAT} の検査（TeamValidator）にかけた結果。`, '');
lines.push(`- 構築の数：${teams.length}`);
lines.push(`- 選出データの数：${selections.length}（記事に選出の情報があるもの：${selections.filter(s => s.has_info).length}）`);

const byRank = new Map(teams.map(t => [t.rank, t]));
const missing = selections.filter(s => !byRank.has(s.rank)).map(s => s.rank);
lines.push(`- 選出データの順位で、構築にないもの：${missing.length ? missing.join(', ') : 'なし'}`);

// 同じ記事URLを持つ構築
const byUrl = new Map<string, number[]>();
for (const t of teams) if (t.article_url) byUrl.set(t.article_url, [...(byUrl.get(t.article_url) ?? []), t.rank]);
const dupUrl = [...byUrl.entries()].filter(([, r]) => r.length > 1);
lines.push(`- 記事URLが同じ構築：${dupUrl.length} 組`);
for (const [u, r] of dupUrl) {
  const same = r.map(x => byRank.get(x)!.mons.map(m => m.species).join('/'));
  lines.push(`  - 順位 ${r.join(', ')}（6匹が${new Set(same).size === 1 ? '同じ' : '違う'}）：${u}`);
}
lines.push(`- 記事URLがない構築：${teams.filter(t => !t.article_url).map(t => t.rank).join(', ') || 'なし'}`);

// 能力ポイントの合計
const evSums = new Map<number, string[]>();
for (const t of teams) for (const m of t.mons) {
  const s = Object.values(m.evs).reduce((a, b) => a + b, 0);
  if (s !== 66) evSums.set(s, [...(evSums.get(s) ?? []), `${t.rank}位 ${m.jp}`]);
}
lines.push(`- 能力ポイントの合計が66でないもの：${[...evSums.values()].flat().length} 匹`);
for (const [s, who] of evSums) lines.push(`  - 合計${s}：${who.join('、')}`);
const fewMoves = teams.flatMap(t => t.mons.filter(m => m.moves.length < 4).map(m => `${t.rank}位 ${m.jp}（${m.moves.length}つ）`));
lines.push(`- 技が4つ未満：${fewMoves.join('、') || 'なし'}`);

lines.push('', '## Showdown の検査で問題が出た構築', '');
let bad = 0;
for (const t of teams) {
  const sets = t.mons.map(m => ({
    name: '', species: m.species, item: m.item, ability: m.ability, nature: m.nature, evs: m.evs,
    ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }, moves: m.moves, level: 50, gender: '',
  }));
  const problems: string[] | null = validator.validateTeam(sets);
  if (problems) {
    bad++;
    lines.push(`- ${t.rank}位：${problems.join(' / ')}`);
  }
}
lines.push('', `問題なし：${teams.length - bad} 構築、問題あり：${bad} 構築。`);
lines.push('', '特性が空のポケモンは、エンジンでは Showdown の種族の最初の特性として扱う予定（未確定）。');
writeFileSync(resolve(ROOT, 'docs/seed-check.md'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
