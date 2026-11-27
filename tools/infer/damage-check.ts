// ダメージの計算（src/infer/calc.ts の damageRolls）が、Showdown で実際に打った結果と合うかを確かめる。
// ランダムな盤面で、こちら（p1）が1発の攻撃技を使い、相手（p2）は何もしない技（はねる）を使う。
// 実際のダメージ（記録の正確なHP）が、計算した16通り（急所かどうかも合わせる）のどれかと一致すれば合格。
// 使い方：npx tsx tools/infer/damage-check.ts [盤面の数=300] [種の数=4]
import { readFileSync } from 'node:fs';
import { loadShowdown, FORMAT } from '../showdown/load.ts';
import { ShowdownRunner } from '../compare/showdown-adapter.ts';
import { genPosition, Rng } from '../compare/gen.ts';
import { makeCalc } from '../../src/infer/calc.ts';
import type { Position } from '../../src/engine/position.ts';

const [NPOS, NSEED] = [300, 4].map((d, i) => Number(process.argv[2 + i] ?? d));
const PS = loadShowdown();
const dex = PS.Dex.forFormat(FORMAT);
const calc = makeCalc(PS, FORMAT);
const validator = PS.TeamValidator.get(FORMAT);
const teams = JSON.parse(readFileSync('data/seed/teams_m7.json', 'utf8')).filter((t: any) => !validator.validateTeam(t.mons.map((m: any) => ({ ...m, name: '', level: 50, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 } }))));
const rng = new Rng(5);
let checked = 0, ok = 0, skipped = 0; const bad: string[] = [];
const skipCount = new Map<string, number>();
const skip = (why: string) => { skipped++; skipCount.set(why, (skipCount.get(why) ?? 0) + 1); };
for (let n = 0; n < NPOS; n++) {
  const pos: Position = genPosition(rng, teams, dex);
  const a = pos.sides[0].mons[pos.sides[0].active], d = pos.sides[1].mons[pos.sides[1].active];
  if (a.hp <= 0 || d.hp <= 0) { n--; continue; }
  // 1発の攻撃技を1つ選ぶ
  const cands = a.set.moves.map((id, k) => ({ id, k, mv: dex.moves.get(id) })).filter(x => x.mv.category !== 'Status' && !x.mv.multihit && !x.mv.ohko && !x.mv.damage && !x.mv.damageCallback && x.mv.id !== 'struggle');
  if (!cands.length) { skip('攻撃技がない'); continue; }
  const pick = cands[rng.int(cands.length)];
  d.set = { ...d.set, moves: ['splash'] };
  delete d.vol; // みがわり等を外す
  a.pp = undefined; a.status = a.status === 'slp' || a.status === 'frz' ? '' : a.status;
  if (a.vol) { delete a.vol.confusion; delete a.vol.choicelock; delete a.vol.taunt; }
  if (['focussash', 'airballoon'].includes(d.set.item) || ['sturdy', 'disguise', 'iceface'].includes(d.set.ability)) { skip('きあいのタスキ・がんじょう・ばけのかわ・ふうせん'); continue; }
  for (let s = 1; s <= NSEED; s++) {
    let r;
    try { r = new ShowdownRunner(pos, s); } catch { skip('盤面を作れない'); continue; }
    const hpBefore = r.battle.sides[1].active[0].hp;
    r.play({ kind: 'move', slot: pick.k }, { kind: 'move', slot: 0 });
    const log: string[] = r.battle.log;
    const mi = log.findIndex(l => l.startsWith('|move|p1a:') && l.includes(`|${pick.mv.name}|`));
    if (mi < 0) { skip('技を出せなかった（まひ・ひるみ等）'); continue; }
    // 相手が先に動いて状態が変わった回（へんげんじざいのタイプ変化など）は対象外。攻撃の直前のHPは記録から読む
    const turnStart = log.lastIndexOf('|turn|1') >= 0 ? log.lastIndexOf('|turn|1') : 0;
    if (log.slice(turnStart, mi).some(l => l.startsWith('|move|p2a:'))) { skip('相手が先に動いた'); continue; }
    const maxhp = r.battle.sides[1].active[0].maxhp;
    let hpAtMove = hpBefore;
    for (const l of log.slice(0, mi)) {
      const mm = /^\|-(?:damage|heal)\|p2a: [^|]*\|(\d+)\/(\d+)/.exec(l);
      if (mm && Number(mm[2]) === maxhp) hpAtMove = Number(mm[1]);
    }
    let crit = false, after: number | null = null, other = false;
    for (let i = mi + 1; i < log.length; i++) {
      const l = log[i];
      if (l.startsWith('|move|') || l.startsWith('|upkeep')) break;
      if (l.startsWith('|-crit|p2a')) crit = true;
      if (l.startsWith('|-miss|') || l.startsWith('|-immune|') || l.startsWith('|-fail|') || l.startsWith('|-activate|p2a') && l.includes('Substitute')) { other = true; break; }
      const m = /^\|-damage\|p2a: [^|]*\|(\d+)\/\d+/.exec(l) ?? /^\|-damage\|p2a: [^|]*\|0 fnt/.exec(l);
      if (m) { after = m[1] !== undefined ? Number(m[1]) : 0; if (l.includes('0 fnt')) after = 0; break; }
    }
    if (other || after === null) { skip('外れた・無効・ダメージなし'); continue; }
    const p2: Position = JSON.parse(JSON.stringify(pos));
    p2.sides[1].mons[p2.sides[1].active].hp = hpAtMove;
    const rolls = calc.damageRolls(p2, 0, pick.id, crit);
    checked++;
    const lost = hpAtMove - after;
    if (rolls && rolls.some(x => Math.min(hpAtMove, x) === lost)) ok++;
    else if (bad.length < 8) bad.push(`盤面${n} 種${s} ${a.set.species}→${d.set.species} ${pick.mv.name}${crit ? '（急所）' : ''}：実際 ${lost}、計算 ${rolls?.join(',')}`);
  }
}
console.log(`確かめた ${checked} 回のうち一致 ${ok} 回。対象外 ${skipped} 回`);
for (const [k, v] of skipCount) console.log(`  対象外：${k} ${v}`);
bad.forEach(x => console.log('不一致', x));
process.exitCode = ok === checked ? 0 : 1;
