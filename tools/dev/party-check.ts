// 開発用：画面から読み取ったパーティの能力値を、Showdown（champions）の計算式で計算し直し、画面の数字と比べる。チームの検査にもかける。
import { readFileSync } from 'node:fs';
import { loadShowdown, FORMAT } from '../showdown/load.ts';
const PS = loadShowdown();
const party = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const sets = party.map((m: any) => ({ name: '', species: m.species, item: m.item, ability: m.ability, nature: m.nature, evs: m.evs, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }, moves: m.moves, level: 50, gender: m.gender }));
const b = new PS.Battle({ formatid: FORMAT, seed: '1,2,3,4' });
b.setPlayer('p1', { name: 'a', team: PS.Teams.pack(sets) });
b.setPlayer('p2', { name: 'b', team: PS.Teams.pack(sets) });
let allOk = true;
b.p1.pokemon.forEach((p: any, i: number) => {
  const m = party[i];
  const calc = { hp: p.maxhp, ...p.storedStats };
  const diff = Object.keys(m.shown).filter(k => calc[k] !== m.shown[k]);
  if (diff.length) allOk = false;
  const sum = Object.values(m.evs as Record<string, number>).reduce((a, x) => a + x, 0);
  console.log(`${m.jp}：${diff.length ? '不一致 ' + diff.map(k => `${k} 計算${calc[k]} 画面${m.shown[k]}`).join('、') : '6つとも一致'}（能力ポイント合計 ${sum}）`);
});
const problems = PS.TeamValidator.get(FORMAT).validateTeam(sets);
console.log('チームの検査：', problems ? problems.join(' / ') : '問題なし');
console.log(allOk ? 'すべて一致' : '一致しない値あり');
