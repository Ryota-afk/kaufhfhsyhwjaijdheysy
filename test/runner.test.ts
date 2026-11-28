import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ShowdownRunner } from '../tools/compare/showdown-adapter.ts';
import { genPosition, Rng } from '../tools/compare/gen.ts';
import { loadShowdown, FORMAT } from '../tools/showdown/load.ts';

test('盤面の形に戻す：盤面から作った対戦を戻すと、もとの盤面と同じ結果になる（200盤面）', () => {
  const PS = loadShowdown(); const dex = PS.Dex.forFormat(FORMAT);
  const teams = JSON.parse(readFileSync('data/seed/teams_m7.json', 'utf8')).filter((t: any) => t.mons.every((m: any) => m.ability) && t.rank !== 59);
  const rng = new Rng(3);
  let n = 0;
  for (let k = 0; k < 200; k++) {
    const pos = genPosition(rng, teams, dex);
    let r; try { r = new ShowdownRunner(pos, 1); } catch { continue; }
    const back = r.toPosition();
    // 戻した盤面から作り直しても、同じ種で打った結果が同じになる
    const a = new ShowdownRunner(pos, 7), b = new ShowdownRunner(back, 7);
    const la = a.legalActions(0), lb = b.legalActions(0);
    assert.deepEqual(lb, la);
    const act0 = la[0], act1 = a.legalActions(1)[0];
    a.play(act0, act1); b.play(act0, act1);
    assert.deepEqual(b.outcome(), a.outcome(), `盤面${k}`);
    n++;
  }
  assert.ok(n > 150);
});

test('メガシンカ済みの盤面：姿が変わったときの特性（ひでり・いかく）で、盤面にない天気や能力ランクが付かない', () => {
  const mon = (species: string, item: string, ability: string, moves: string[], extra: any = {}) => ({ set: { species, item, ability, nature: 'Hardy', evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }, moves }, hp: 150, status: '' as const, ...extra });
  const pos: any = { sides: [
    { mons: [mon('Primarina', 'sitrusberry', 'torrent', ['aquajet'])], active: 0 },
    { mons: [mon('Charizard', 'charizarditey', 'blaze', ['flamethrower'], { mega: true })], active: 0, megaUsed: true },
  ], field: {} };
  const r = new ShowdownRunner(pos, 1);
  assert.equal(r.battle.field.weather, '');
  assert.equal(r.battle.sides[1].active[0].species.name, 'Charizard-Mega-Y');
  const pos2: any = { sides: [
    { mons: [mon('Primarina', 'sitrusberry', 'torrent', ['aquajet'])], active: 0 },
    { mons: [mon('Manectric', 'manectite', 'static', ['thunderbolt'], { mega: true })], active: 0, megaUsed: true },
  ], field: {} };
  const r2 = new ShowdownRunner(pos2, 1);
  assert.equal(r2.battle.sides[0].active[0].boosts.atk, 0);
});

test('死に出しの場面：場の体が倒れていて控えがあれば、交代先を選ぶ要求になり、選ぶと次のターンの技の要求になる', () => {
  const mon = (species: string, item: string, ability: string, moves: string[], hp = 150) => ({ set: { species, item, ability, nature: 'Hardy', evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }, moves }, hp, status: '' as const });
  const pos: any = { sides: [
    { mons: [mon('Kleavor', 'focussash', 'sharpness', ['stoneaxe'], 0), mon('Salamence', 'leftovers', 'intimidate', ['dragonclaw']), mon('Garchomp', 'lifeorb', 'roughskin', ['earthquake'])], active: 0, cond: { stealthrock: true } },
    { mons: [mon('Hippowdon', 'leftovers', 'sandstream', ['earthquake'])], active: 0 },
  ], field: {} };
  const r = new ShowdownRunner(pos, 1);
  const l0 = r.legalActions(0), l1 = r.legalActions(1);
  assert.deepEqual(l0, [{ kind: 'switch', to: 1 }, { kind: 'switch', to: 2 }]);
  assert.equal(l1.length, 0);
  r.play({ kind: 'switch', to: 1 }, null);
  const p = r.toPosition();
  assert.equal(p.sides[0].active, 1);
  // ステルスロック（ドラゴン・ひこうに1/4……ボーマンダはひこうで2倍：最大HPの1/4）を受けている
  const sal = p.sides[0].mons[1];
  assert.ok(sal.hp < 171, `HP ${sal.hp}`);
  assert.ok(r.legalActions(0).some(a => a.kind === 'move'));
});
