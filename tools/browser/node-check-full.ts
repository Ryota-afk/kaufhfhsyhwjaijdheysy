// 入力画面用に組み立てた Showdown（.build/showdown-full.mjs）のチームの検査と覚えられる技の一覧が、元の Showdown と同じになるかを Node で確かめる。
import { readFileSync } from 'node:fs';
import { loadShowdown, FORMAT } from '../showdown/load.ts';
const { PS: B } = await import('../../.build/showdown-full.mjs' as any);
const PS = loadShowdown();
const teams = JSON.parse(readFileSync('data/seed/teams_m7.json', 'utf8'));
const party = JSON.parse(readFileSync(process.argv[2] ?? 'data/parties/team2.json', 'utf8'));
const toSet = (m: any) => ({ name: '', species: m.species, item: m.item, ability: m.ability, nature: m.nature, evs: m.evs, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }, moves: m.moves, level: 50, gender: m.gender ?? '' });
const vA = PS.TeamValidator.get(FORMAT), vB = B.TeamValidator.get(FORMAT);
let same = 0, total = 0;
for (const t of [...teams, { rank: 'party', mons: party.mons }]) {
  total++;
  const a = JSON.stringify(vA.validateTeam(t.mons.map(toSet))), b = JSON.stringify(vB.validateTeam(t.mons.map(toSet)));
  if (a === b) same++; else console.log('検査の違い', t.rank, a, b);
}
const dA = PS.Dex.forFormat(FORMAT), dB = B.Dex.forFormat(FORMAT);
let mpSame = 0, mpTotal = 0;
for (const s of dA.species.all()) {
  if (!s.exists || s.isNonstandard) continue;
  mpTotal++;
  const a = [...dA.species.getMovePool(s.id)].sort().join(), b = [...dB.species.getMovePool(s.id)].sort().join();
  if (a === b) mpSame++; else if (mpTotal - mpSame < 3) console.log('技の一覧の違い', s.id);
}
console.log(`チームの検査：一致 ${same} / ${total}。覚えられる技の一覧：一致 ${mpSame} / ${mpTotal}`);
