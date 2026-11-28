// 段階3：相手の型の推定の例。期待値は、推定の本体とは別の方法で計算して比べる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { expandPrior, OpponentSet, clueItem, clueAbility, movesLikelihood, type PriorEntry, type SetCand } from '../src/infer/sets.ts';
import { makeCalc, shownPercent } from '../src/infer/calc.ts';
import { BenchModel, trioDist } from '../src/infer/bench.ts';
import { calcStat } from '../src/party/model.ts';
import { loadShowdown, FORMAT } from '../tools/showdown/load.ts';
import { ShowdownRunner } from '../tools/compare/showdown-adapter.ts';
import type { Position, PosMon } from '../src/engine/position.ts';

const priors = JSON.parse(readFileSync('data/priors/sets.json', 'utf8'));
const party = JSON.parse(readFileSync('test/fixtures/party-team2-screen.json', 'utf8'));
const dexJson = JSON.parse(readFileSync('src/engine/data/dex.json', 'utf8'));
const toID = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const PS = loadShowdown();
const calc = makeCalc(PS, FORMAT);
const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;
const garchomp = (): PriorEntry => priors.species.garchomp;

test('最初の候補：どの種族も確率の合計が1。上位構築に100回出るガブリアスは「それ以外」が1/101', () => {
  for (const id of Object.keys(priors.species)) {
    const c = expandPrior(priors.species[id]);
    assert.ok(c.length > 0, id);
    assert.ok(close(c.reduce((a, x) => a + x.prior, 0), 1, 1e-6), id);
  }
  const g = expandPrior(garchomp());
  assert.ok(close(g.filter(x => x.generic).reduce((a, x) => a + x.prior, 0), 1 / 101, 1e-9));
});

test('技：ガブリアスがステルスロックを見せたら、持ち物の確率が候補の表からの計算どおりに動く', () => {
  const e = garchomp();
  const set = new OpponentSet(expandPrior(e));
  set.revealMove('Stealth Rock');
  // 別の計算：上位構築の型はステルスロックを持つものだけ、generic は「候補から4つにステルスロックが入る確率」4/n
  const want = new Map<string, number>();
  const seedW = e.seed.reduce((a, s) => a + s.w, 0);
  for (const s of e.seed) if (s.moves.includes('Stealth Rock')) want.set(s.item, (want.get(s.item) ?? 0) + (1 - e.otherWeight) * s.w / seedW);
  for (const g of e.generic) {
    if (!g.pool.includes('Stealth Rock')) continue;
    const n = g.pool.length, like = n <= 4 ? 1 : 4 / n;
    for (const it of g.items) for (const sp of g.spreads) want.set(it.item, (want.get(it.item) ?? 0) + e.otherWeight / e.generic.length * it.w * sp.w * like);
  }
  const total = [...want.values()].reduce((a, b) => a + b, 0);
  const got = set.marginal(c => c.item);
  for (const [item, w] of want) assert.ok(close(got.get(item) ?? 0, w / total), `${item}：${got.get(item)} と ${w / total}`);
  // ステルスロックを持たない上位構築の型は確率0
  set.posterior()!.forEach((p, i) => { const c = set.cands[i]; if (!c.generic && !c.moves.includes('Stealth Rock')) assert.equal(p, 0); });
});

test('持ち物・特性：たべのこしが見えたら持ち物はたべのこしだけ。さめはだも見えたら特性はさめはだだけ', () => {
  const set = new OpponentSet(expandPrior(garchomp()));
  set.add(clueItem('Leftovers'));
  const items = [...set.marginal(c => c.item).entries()];
  assert.equal(items.length, 1); assert.equal(items[0][0], 'Leftovers'); assert.ok(close(items[0][1], 1));
  set.add(clueAbility('Rough Skin'));
  const ab = set.marginal(c => c.ability);
  assert.ok(close(ab.get('Rough Skin')!, 1));
});

test('技（generic）：候補から4つ選ぶ確率どおり', () => {
  const c: SetCand = { prior: 1, generic: true, item: '', ability: '', nature: 'Hardy', evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }, moves: [], pool: ['A', 'B', 'C', 'D', 'E', 'F'] };
  assert.ok(close(movesLikelihood(c, ['A']), 4 / 6));             // C(5,3)/C(6,4)
  assert.ok(close(movesLikelihood(c, ['A', 'B']), 6 / 15));       // C(4,2)/C(6,4)
  assert.equal(movesLikelihood(c, ['Z']), 0);
});

// 盤面：こちら（p1）の場の1匹と、相手（p2）の場の1匹
function mon(m: any, hp?: number): PosMon {
  const set = { species: m.species, item: toID(m.item), ability: toID(m.ability), nature: m.nature, evs: m.evs, moves: m.moves.map(toID) };
  return { set, hp: hp ?? dexJson.species[toID(m.species)].baseStats.hp + m.evs.hp + 75, status: '' };
}
const filler = (sp: string) => ({ set: { species: sp, item: '', ability: dexJson.species[sp].abilities['0'], nature: 'Hardy', evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }, moves: ['protect'] }, hp: 100, status: '' as const });
function pos(our: PosMon, opp: PosMon): Position {
  return { sides: [{ mons: [our, filler('clefable'), filler('metagross')], active: 0 }, { mons: [opp, filler('gyarados'), filler('incineroar')], active: 0 }] };
}
const lucario = party.find((m: any) => m.species === 'Lucario');
const salamence = party.find((m: any) => m.species === 'Salamence');

test('素早さ：すばやさ156のルカリオより相手のガブリアスが先に動いたら、すばやさ156を超える候補だけが残る（同速は半分）', () => {
  const set = new OpponentSet(expandPrior(garchomp()));
  const base = pos(mon(lucario), mon({ species: 'Garchomp', item: '', ability: 'Rough Skin', nature: 'Hardy', evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }, moves: ['Earthquake'] }));
  set.add(calc.clueOrder(base, 0, 'Garchomp', 'Aura Sphere', 'Earthquake', true));
  // 別の計算：実数値の式×こだわりスカーフ1.5倍（切り捨て）
  const nat = (n: string) => dexJson.natures[n];
  const speed = (c: SetCand) => {
    const v = calcStat('spe', 102, c.evs.spe, nat(c.nature).plus, nat(c.nature).minus);
    return toID(c.item) === 'choicescarf' ? Math.floor(v * 1.5) : v;
  };
  const prior = set.cands.map(c => c.prior * movesLikelihood(c, []) * (speed(c) > 156 ? 1 : speed(c) === 156 ? 0.5 : 0));
  const total = prior.reduce((a, b) => a + b, 0);
  const post = set.posterior()!;
  post.forEach((p, i) => assert.ok(close(p, prior[i] / total), `${set.cands[i].item} ${set.cands[i].nature} ${set.cands[i].evs.spe}`));
  const scarf = set.marginal(c => c.item).get('Choice Scarf') ?? 0;
  assert.ok(scarf > (expandPrior(garchomp()).filter(c => c.item === 'Choice Scarf').reduce((a, c) => a + c.prior, 0)), 'スカーフの確率が上がる');
});

test('ダメージ（相手の%）：計算した「見えるHP」の確率が、実際に1500回打った結果の割合と合う', () => {
  // こちらのボーマンダのすてみタックルを、相手のガブリアスの2つの型に当てる
  const cands = expandPrior(garchomp()).filter(c => !c.generic);
  const pick = [cands.find(c => c.evs.def >= 20)!, cands.find(c => c.evs.hp <= 4 && c.evs.def === 0)!];
  for (const c of pick) {
    const oppMon = mon({ species: 'Garchomp', item: c.item, ability: c.ability, nature: c.nature, evs: c.evs, moves: ['Splash'] });
    const p = pos(mon(salamence), oppMon);
    const maxhp = 108 + c.evs.hp + 75;
    // 計算：見えるHP after ごとの確率（急所なし）
    const rolls = calc.damageRolls(JSON.parse(JSON.stringify(p)), 0, 'Double-Edge', false)!;
    const want = new Map<number, number>();
    for (const d of rolls) { const a = shownPercent(maxhp - d, maxhp); want.set(a, (want.get(a) ?? 0) + 1 / 16); }
    // 実際：1500回打って、急所でなかった回の見えるHPの割合
    const got = new Map<number, number>(); let n = 0;
    for (let s = 1; s <= 1500; s++) {
      const r = new ShowdownRunner(p, s);
      r.play({ kind: 'move', slot: 0 }, { kind: 'move', slot: 0 });
      const log: string[] = r.battle.log;
      const mi = log.findIndex(l => l.startsWith('|move|p1a: Salamence|Double-Edge'));
      if (mi < 0) continue;
      const tail = log.slice(mi, mi + 8);
      if (tail.some(l => l.startsWith('|-crit|') || l.startsWith('|-miss|'))) continue;
      const dl = tail.find(l => /^\|-damage\|p2a: Garchomp\|\d+\/100/.test(l));
      if (!dl) continue;
      const a = Number(/\|(\d+)\/100/.exec(dl)![1]);
      got.set(a, (got.get(a) ?? 0) + 1); n++;
    }
    for (const [a, w] of want) {
      const f = (got.get(a) ?? 0) / n, sd = Math.sqrt(w * (1 - w) / n);
      assert.ok(Math.abs(f - w) < 4 * sd + 1e-9, `${c.nature} ${JSON.stringify(c.evs)} ${a}%：計算 ${w.toFixed(3)}、実際 ${f.toFixed(3)}（${n}回）`);
    }
    for (const a of got.keys()) assert.ok(want.has(a), `計算にない ${a}% が出た`);
    // 手がかりとして使うと、合わない見え方の確率は0、合う見え方は計算どおり
    const [a0] = [...want.keys()];
    const clue = calc.clueDamageToOpp(p, 0, 'Garchomp', 'Double-Edge', 100, a0, false);
    assert.ok(close(clue.like(c), want.get(a0)!, 1e-9));
  }
});

test('ダメージ（こちらの実数）：実際に打たれたHPの減り方で、打った型の候補は残る', () => {
  const garchompSet = party.find((m: any) => m.species === 'Garchomp');
  const cands = expandPrior(priors.species.salamence).filter(c => !c.generic && c.moves.includes('Double-Edge'));
  const c = cands[0];
  const p = pos(mon(garchompSet), mon({ species: 'Salamence', item: c.item, ability: c.ability, nature: c.nature, evs: c.evs, moves: ['Double-Edge'] }));
  p.sides[0].mons[0].set.moves = ['splash'];
  for (let s = 1; s <= 20; s++) {
    const r = new ShowdownRunner(p, s);
    const before = r.battle.sides[0].active[0].hp;
    r.play({ kind: 'move', slot: 0 }, { kind: 'move', slot: 0 });
    const log: string[] = r.battle.log;
    const mi = log.findIndex(l => l.startsWith('|move|p2a: Salamence|Double-Edge'));
    if (mi < 0) continue;
    const tail = log.slice(mi, mi + 8);
    const crit = tail.some(l => l.startsWith('|-crit|p1a'));
    const dl = tail.find(l => /^\|-damage\|p1a: Garchomp\|\d+\/\d{3}/.test(l));
    if (!dl) continue;
    const after = Number(/\|(\d+)\/\d+/.exec(dl)![1]);
    const clue = calc.clueDamageFromOpp(p, 0, 'Salamence', 'Double-Edge', before, after, crit);
    assert.ok(clue.like(c) > 0, `種${s}：${before}→${after}`);
  }
});

test('控え：記事の選出の枠どおりに3匹の組ができ、見えたポケモンを条件にすると確率が動く', () => {
  assert.deepEqual([...trioDist([[1], [2], [3]])], [['1,2,3', 1]]);
  const d = trioDist([[1], [2], []]);
  assert.equal(d.size, 4);
  for (const v of d.values()) assert.ok(close(v, 1 / 4));
  const teams = JSON.parse(readFileSync('data/seed/teams_m7.json', 'utf8'));
  const sels = JSON.parse(readFileSync('data/seed/selections_m7.json', 'utf8'));
  const bm = new BenchModel(teams, sels);
  // 1位の構築（基本選出 [1],[2],[3]）とまったく同じ6匹なら、1・2・3番が確率 0.9＋0.1×10/20＝0.95、ほかは 0.1×10/20＝0.05
  // （記事にない組も出るので、どの組も同じ割合の分布を1割混ぜている。1匹は20通りの組のうち10通りに入る）
  const t1 = teams.find((t: any) => t.rank === 1);
  const inc = BenchModel.inclusion(bm.prior(t1.mons.map((m: any) => m.species), []), []);
  assert.ok(close(inc[1], 0.95) && close(inc[2], 0.95) && close(inc[3], 0.95) && close(inc[0], 0.05), inc.join());
  // 知らない6匹：見えた3匹が確率1、残りは0。見えた1匹なら、合計はいつも3
  const unknown = ['Pikachu', 'Snorlax', 'Garchomp', 'Gengar', 'Lucario', 'Salamence'];
  const dist = bm.prior(unknown, []);
  const i1 = BenchModel.inclusion(dist, [0]);
  assert.ok(close(i1[0], 1) && close(i1.reduce((a, b) => a + b, 0), 3));
  const i3 = BenchModel.inclusion(dist, [0, 2, 4]);
  assert.deepEqual(i3.map(x => Math.round(x * 1e9) / 1e9), [1, 0, 1, 0, 1, 0]);
  // 選ばれやすい種族ほど確率が高い（ガブリアスの割合が、上位構築にない種族の0.5より高ければ）
  const rG = bm.speciesRate('Garchomp');
  const i0 = BenchModel.inclusion(dist, []);
  assert.equal(i0[2] > i0[0], rG > 0.5);
});
