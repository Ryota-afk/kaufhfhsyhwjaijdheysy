// 指示文 4-1. の項目を1つずつ確かめる。
// 使い方：npx tsx tools/compare/rules.ts ref|fast
//   ref  = 速さの層なしの Showdown（記録を読んで、処理の順番も確かめる）
//   fast = エンジン（速さの層あり、盤面を作った後に複製して打つ。記録は作らないので、状態だけで確かめる）
// 結果は .build/rules-<mode>.json に書く。両方を合わせた表は tools/compare/rules-report.ts が作る。
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadShowdown, FORMAT } from '../showdown/load.ts';
import type { Position, PosMon, Action, MonSet } from '../../src/engine/position.ts';

const mode = process.argv[2] === 'fast' ? 'fast' : 'ref';
const PS = loadShowdown();
let clone: ((b: any) => any) | null = null;
if (mode === 'fast') {
  const { applySpeedLayer } = await import('../../src/engine/fast.ts');
  const { makeCloner } = await import('../../src/engine/clone.ts');
  applySpeedLayer(PS, PS.Battle, FORMAT);
  clone = makeCloner(PS.Dex.forFormat(FORMAT));
}
const { ShowdownRunner } = await import('./showdown-adapter.ts');
const dex = PS.Dex.forFormat(FORMAT);

function mon(species: string, o: Partial<MonSet> & { hp?: number; status?: any; boosts?: any; pp?: number[] } = {}): PosMon {
  const set: MonSet = {
    species, item: o.item ?? '', ability: o.ability ?? dex.species.get(species).abilities[0], nature: o.nature ?? 'Hardy',
    evs: o.evs ?? { hp: 2, atk: 32, def: 0, spa: 0, spd: 0, spe: 32 }, moves: o.moves ?? ['calmmind'],
  };
  const maxhp = dex.species.get(species).baseStats.hp + set.evs.hp + 75;
  return { set, hp: o.hp ?? maxhp, status: o.status ?? '', boosts: o.boosts, pp: o.pp };
}
const maxhpOf = (m: PosMon) => dex.species.get(m.set.species).baseStats.hp + m.set.evs.hp + 75;
function runner(pos: Position, seed: number) {
  const r = new ShowdownRunner(pos, seed);
  if (clone) r.battle = clone(r.battle);
  return r;
}
const mv = (slot: number, mega = false): Action => ({ kind: 'move', slot, mega });
const sw = (to: number): Action => ({ kind: 'switch', to });
const logOf = (r: any): string[] => (mode === 'ref' ? r.battle.log : []);
const results: any[] = [];
function record(id: string, title: string, rule: string, measured: Record<string, any>, pass: boolean | null, fingerprint: string[], note = '') {
  results.push({ id, title, rule, measured, pass, fingerprint, note });
  console.log(`${pass === null ? '－' : pass ? '合格' : '不合格'} ${id} ${title}`);
}
const fp = (r: any) => JSON.stringify(r.outcome());

// 1. まきびし
{
  const rows: any[] = []; const fps: string[] = []; let ok = true;
  for (const layers of [1, 2, 3]) for (const [sp, hpEv] of [['garchomp', 0], ['garchomp', 5], ['snorlax', 13], ['metagross', 32], ['heracross', 7], ['clefable', 1]] as const) {
    const pos: Position = {
      sides: [
        { mons: [mon('tyranitar'), mon(sp, { evs: { hp: hpEv, atk: 32, def: 0, spa: 0, spd: 0, spe: 2 } }), mon('corviknight')], active: 0, cond: { spikes: layers } },
        { mons: [mon('kingambit'), mon('gyarados'), mon('incineroar')], active: 0 },
      ],
    };
    const r = runner(pos, 1); r.play(sw(1), mv(0));
    const m = pos.sides[0].mons[1]; const maxhp = maxhpOf(m);
    const lost = maxhp - r.outcome().sides[0].mons[1].hp;
    const expect = Math.floor(maxhp * [3, 4, 6][layers - 1] / 24);
    if (lost !== expect) ok = false;
    rows.push(`${layers}層 ${sp} 最大HP${maxhp}：減った ${lost}（期待 ${expect}）`);
    fps.push(fp(r));
  }
  record('spikes', 'まきびしのダメージ', '1層1/8、2層1/6、3層1/4（最大HP×[3,4,6]/24 を切り捨て）', { 例: rows }, ok, fps);
}

// 2. 連続技の急所は1発ごとに独立
{
  const N = 4000;
  const fps: string[] = []; let hitsTotal = 0, critsTotal = 0; const byHits = new Map<number, number[]>(); let ko = 0;
  for (let s = 1; s <= N; s++) {
    const pos: Position = {
      sides: [
        { mons: [mon('garchomp', { moves: ['rockblast'] }), mon('clefable'), mon('metagross')], active: 0 },
        { mons: [mon('snorlax', { hp: 150, evs: { hp: 32, atk: 0, def: 0, spa: 0, spd: 32, spe: 2 } }), mon('gyarados'), mon('incineroar')], active: 0 },
      ],
    };
    const r = runner(pos, s); r.play(mv(0), mv(0));
    const o = r.outcome(); if (o.sides[1].mons[0].hp === 0) ko++;
    fps.push(JSON.stringify(o.sides[1].mons[0]));
    if (mode === 'ref') {
      const log = logOf(r);
      const start = log.findIndex(l => l.includes('|move|p1a: Garchomp|Rock Blast'));
      if (start < 0) continue;
      let crits = 0, hits = 0;
      for (let i = start + 1; i < log.length; i++) {
        const l = log[i];
        if (l.startsWith('|move|')) break;
        if (l.startsWith('|-crit|p2a')) crits++;
        if (l.startsWith('|-hitcount|')) { hits = Number(l.split('|')[3]); break; }
        if (l.startsWith('|-miss|')) break;
      }
      if (!hits) continue;
      hitsTotal += hits; critsTotal += crits;
      const a = byHits.get(hits) ?? []; a.push(crits); byHits.set(hits, a);
    }
  }
  const measured: Record<string, any> = { 使った回数: N, '倒した割合（エンジンと Showdown で一致するか比べる）': (ko / N).toFixed(4) };
  let pass: boolean | null = null;
  if (mode === 'ref') {
    const p = 1 / 24;
    measured['1発あたりの急所率'] = `${(critsTotal / hitsTotal).toFixed(4)}（期待 ${p.toFixed(4)}、${hitsTotal}発）`;
    // 2発以上当たった回で、急所の数の分布が「1発ごとに独立」の二項分布と合うか。
    // 1回の技で急所をまとめて決める作りなら、急所が出た回は全部の発が急所になる。
    let allCrit = 0, someCrit = 0, expectAll = 0, expectSome = 0;
    for (const [h, arr] of byHits) {
      if (h < 2) continue;
      for (const c of arr) { if (c > 0) someCrit++; if (c === h) allCrit++; }
      expectSome += arr.length * (1 - (1 - p) ** h); expectAll += arr.length * p ** h;
    }
    measured['2発以上の回で、急所が1発以上'] = `${someCrit}（独立なら期待 ${expectSome.toFixed(1)}）`;
    measured['2発以上の回で、全部の発が急所'] = `${allCrit}（独立なら期待 ${expectAll.toFixed(2)}。まとめて決める作りなら ${someCrit} と同じになる）`;
    pass = Math.abs(critsTotal / hitsTotal - p) < 4 * Math.sqrt(p * (1 - p) / hitsTotal) && allCrit <= Math.max(3, expectAll * 5);
  }
  record('multihitcrit', '連続技の急所は1発ごとに独立', '急所は1発ごとに独立して決まる（ロックブラスト、2〜5発）', measured, pass, fps);
}

// 3. 吸い取る技の回復は、さめはだ・ゴツゴツメットより先
{
  const N = 300; let survived = 0; let orderOk = 0, orderSeen = 0; const fps: string[] = [];
  for (let s = 1; s <= N; s++) {
    const pos: Position = {
      sides: [
        { mons: [mon('lucario', { moves: ['drainpunch'], hp: 30, boosts: { atk: 4 } }), mon('clefable'), mon('metagross')], active: 0 },
        { mons: [mon('garchomp', { ability: 'roughskin', item: 'rockyhelmet', moves: ['calmmind'], evs: { hp: 32, atk: 0, def: 0, spa: 0, spd: 0, spe: 32 } }), mon('gyarados'), mon('incineroar')], active: 0 },
      ],
    };
    const r = runner(pos, s); r.play(mv(0), mv(0));
    const o = r.outcome(); if (o.sides[0].mons[0].hp > 0) survived++;
    fps.push(fp(r));
    if (mode === 'ref') {
      const log = logOf(r);
      const heal = log.findIndex(l => l.startsWith('|-heal|p1a: Lucario') && l.includes('[from] drain'));
      const rough = log.findIndex(l => l.startsWith('|-damage|p1a: Lucario') && l.includes('Rough Skin'));
      const helmet = log.findIndex(l => l.startsWith('|-damage|p1a: Lucario') && l.includes('Rocky Helmet'));
      if (heal >= 0 && rough >= 0 && helmet >= 0) { orderSeen++; if (heal < rough && heal < helmet) orderOk++; }
    }
  }
  const measured: Record<string, any> = { 回数: N, 'HP30のルカリオが生き残った割合': (survived / N).toFixed(3) };
  if (mode === 'ref') measured['記録で「回復」が「さめはだ」「ゴツゴツメット」より先だった回数'] = `${orderOk} / ${orderSeen}`;
  record('drainorder', '吸い取る技の回復は、さめはだ・ゴツゴツメットより先', 'ドレインパンチの回復が先に入り、そのあと反撃のダメージ', measured,
    mode === 'ref' ? orderOk === orderSeen && orderSeen > 0 : survived === N, fps, 'HP30・攻撃+4のルカリオが、さめはだ＋ゴツゴツメットのガブリアスを殴る。回復が後なら反撃で倒れる。');
}

// 4. わるあがきの反動は最大HPの1/4を四捨五入
{
  const rows: string[] = []; let ok = true; const fps: string[] = [];
  for (const hpEv of [0, 1, 2, 3, 4, 7]) {
    const atk = mon('garchomp', { moves: ['earthquake', 'swordsdance'], pp: [0, 0], evs: { hp: hpEv, atk: 0, def: 0, spa: 0, spd: 32, spe: 32 } });
    const pos: Position = { sides: [
      { mons: [atk, mon('clefable'), mon('metagross')], active: 0 },
      { mons: [mon('skarmory', { moves: ['calmmind'] }), mon('gyarados'), mon('incineroar')], active: 0 },
    ] };
    const r = runner(pos, 1);
    const legal = r.legalActions(0);
    r.play(legal.find(a => a.kind === 'move')!, mv(0));
    const maxhp = maxhpOf(atk); const lost = maxhp - r.outcome().sides[0].mons[0].hp;
    const expect = Math.max(1, Math.round(maxhp / 4));
    if (lost !== expect) ok = false;
    rows.push(`最大HP${maxhp}：反動 ${lost}（四捨五入なら ${expect}、切り捨てなら ${Math.floor(maxhp / 4)}）`);
    fps.push(fp(r));
  }
  record('struggle', 'わるあがきの反動', '最大HPの1/4を四捨五入', { 例: rows }, ok, fps);
}

// 5. レッドカード
{
  const N = 400; let dragged = 0, used = 0; const to = [0, 0, 0]; let koNoAct = 0; const fps: string[] = [];
  for (let s = 1; s <= N; s++) {
    const pos: Position = { sides: [
      { mons: [mon('garchomp', { moves: ['earthquake'], boosts: { atk: -2 } }), mon('clefable'), mon('metagross')], active: 0 },
      { mons: [mon('snorlax', { item: 'redcard', moves: ['calmmind'], evs: { hp: 32, atk: 0, def: 32, spa: 0, spd: 0, spe: 2 } }), mon('gyarados'), mon('incineroar')], active: 0 },
    ] };
    const r = runner(pos, s); r.play(mv(0), mv(0));
    const o = r.outcome();
    if (o.sides[0].active !== 0) { dragged++; to[o.sides[0].active]++; }
    if (o.sides[1].mons[0].item === '') used++;
    fps.push(fp(r));
    // 持ち主が倒れたときは発動しない
    const pos2: Position = JSON.parse(JSON.stringify(pos)); pos2.sides[1].mons[0].hp = 1;
    const r2 = runner(pos2, s); r2.play(mv(0), mv(0));
    const o2 = r2.outcome();
    if (o2.sides[1].mons[0].hp === 0 && o2.sides[0].active === 0 && o2.sides[1].mons[0].item === 'redcard') koNoAct++;
    fps.push(fp(r2));
  }
  record('redcard', 'レッドカード', '攻撃を受けて残ったら、攻撃した側を控えと入れ替えて消える。持ち主が倒れたら発動しない', {
    回数: N, '攻撃側が入れ替わった': dragged, 'カードが消えた': used, '入れ替わり先（控え1／控え2）': `${to[1]} / ${to[2]}`, '持ち主が倒れた回で発動しなかった': koNoAct,
  }, dragged === N && used === N && koNoAct === N, fps);
}

// 6. かなしばり
{
  const fps: string[] = []; const res: string[] = []; let ok = true;
  // 速い側がかける（相手はそのターンまだ動いていない）／遅い側がかける（相手はもう動いた）
  for (const [label, user, target] of [['相手がまだ動いていないターンにかけた', 'gengar', 'snorlax'], ['相手がもう動いた後にかけた', 'hippowdon', 'gyarados']] as const) {
    const lens: number[] = [];
    for (let s = 1; s <= 30; s++) {
      const pos: Position = { sides: [
        { mons: [mon(user, { moves: ['disable', 'calmmind'] }), mon('clefable'), mon('metagross')], active: 0 },
        { mons: [mon(target, { moves: ['calmmind', 'recover'] }), mon('kingambit'), mon('incineroar')], active: 0 },
      ] };
      const r = runner(pos, s);
      r.play(mv(1), mv(0));        // 1ターン目：お互いめいそう
      r.play(mv(0), mv(1));        // 2ターン目：かなしばり（相手はじこさいせい）
      let n = 0;
      for (let t = 0; t < 8; t++) {
        // かなしばりを受けた技（相手が最後に使った技）が選べない間を数える。相手は選べるほうの技を使う
        const moves = r.legalActions(1).filter(a => a.kind === 'move');
        if (moves.length === 2) break;
        n++; r.play(mv(1), moves[0]);
      }
      lens.push(n); fps.push(fp(r));
    }
    const uniq = [...new Set(lens)];
    res.push(`${label}：次のターンから ${uniq.join('、')} ターン選べなかった`);
    if (uniq.length !== 1) ok = false;
  }
  record('disable', 'かなしばり', 'かなしばりを受けた技は4ターン選べない（相手がまだ動いていないターンにかけたら、そのターンを1ターン目と数える）', { 結果: res },
    ok && res[0].includes(' 3 ターン') && res[1].includes(' 4 ターン'), fps, 'Showdown の disable は duration 5 で、相手がそのターンまだ動いていなければ 4 に減らす（data/moves.ts）。');
}

// 7. のろわれボディ
{
  const N = 3000; let dis = 0; const fps: string[] = [];
  for (let s = 1; s <= N; s++) {
    const pos: Position = { sides: [
      { mons: [mon('snorlax', { moves: ['earthquake'], boosts: { atk: -6 } }), mon('clefable'), mon('metagross')], active: 0 },
      { mons: [mon('gengar', { ability: 'cursedbody', moves: ['calmmind'], evs: { hp: 32, atk: 0, def: 32, spa: 0, spd: 0, spe: 2 } }), mon('gyarados'), mon('incineroar')], active: 0 },
    ] };
    const r = runner(pos, s); r.play(mv(0), mv(0));
    const o = r.outcome();
    if (o.sides[0].mons[0].vols.includes('disable')) dis++;
    fps.push(fp(r));
  }
  const rate = dis / N; const sd = Math.sqrt(0.3 * 0.7 / N);
  record('cursedbody', 'のろわれボディ', '攻撃を受けると30%で、その技をかなしばり状態にする', { 回数: N, かなしばりになった割合: `${rate.toFixed(4)}（期待 0.3、誤差の目安 ±${(2 * sd).toFixed(4)}）` },
    Math.abs(rate - 0.3) < 4 * sd, fps);
}

// 8. 同じ持ち物は1チーム1つまで
{
  const v = PS.TeamValidator.get(FORMAT);
  const base = (item: string, i: number) => ({ name: '', species: ['garchomp', 'clefable', 'metagross', 'gyarados', 'incineroar', 'kingambit'][i], item, ability: '', moves: ['protect'], nature: 'Hardy', evs: { hp: 2, atk: 32, def: 0, spa: 0, spd: 0, spe: 32 }, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }, level: 50 });
  const fix = (t: any[]) => t.map(s => ({ ...s, ability: dex.species.get(s.species).abilities[0] }));
  const dup = fix([0, 1, 2, 3, 4, 5].map(i => base(i < 2 ? 'leftovers' : ['lifeorb', 'focussash', 'choicescarf', 'sitrusberry', 'rockyhelmet', 'airballoon'][i], i)));
  const uniq = fix([0, 1, 2, 3, 4, 5].map(i => base(['leftovers', 'lifeorb', 'focussash', 'choicescarf', 'sitrusberry', 'rockyhelmet'][i], i)));
  const pDup = v.validateTeam(dup), pUniq = v.validateTeam(uniq);
  record('itemclause', '同じ持ち物は1チーム1つまで', 'たべのこしを2体に持たせたチームは検査で弾かれ、全部違うチームは通る', {
    同じ持ち物2つ: pDup ? `弾かれた（${pDup.join(' / ')}）` : '通った', 全部違う: pUniq ? `弾かれた（${pUniq.join(' / ')}）` : '通った',
  }, !!pDup && !pUniq, [String(!!pDup), String(!pUniq)]);
}

// 9. メガシンカは1対戦で1回だけ
{
  const fps: string[] = []; let ok = true; const notes: string[] = [];
  const pos: Position = { sides: [
    { mons: [mon('garchomp', { item: 'garchompitez', moves: ['earthquake'] }), mon('lucario', { item: 'lucarionite', moves: ['closecombat'] }), mon('metagross')], active: 0 },
    { mons: [mon('snorlax', { moves: ['calmmind'] }), mon('gyarados'), mon('incineroar')], active: 0 },
  ] };
  const r = runner(pos, 1);
  const before = r.legalActions(0).some(a => a.kind === 'move' && a.mega);
  r.play(mv(0, true), mv(0));
  const spAfter = r.outcome().sides[0].mons[0].species;
  r.play(sw(1), mv(0));
  const after = r.legalActions(0).some(a => a.kind === 'move' && a.mega);
  const accepted = r.battle.choose('p1', 'move 1 mega');
  notes.push(`最初にメガシンカを選べた：${before}`, `メガシンカ後のガブリアスの姿：${spAfter}`, `ルカリオに交代した後にメガシンカを選べる：${after}`, `「move 1 mega」を送ったときに受け付けられた：${accepted}`);
  if (!before || after || accepted || !spAfter.includes('mega')) ok = false;
  fps.push(fp(r));
  record('megaonce', 'メガシンカは1対戦で1回だけ', '1体がメガシンカした後は、ほかの個体はメガシンカを選べない', { 結果: notes }, ok, fps);
}

// 10. 最後の1体どうしが同時に倒れたら、後に倒れた側の勝ち
{
  const cases: [string, PosMon, PosMon, string][] = [
    ['いのちのたまの反動', mon('garchomp', { item: 'lifeorb', moves: ['earthquake'], hp: 1 }), mon('metagross', { hp: 1, moves: ['calmmind'] }), '攻撃側（p1）が後に倒れる'],
    ['ゴツゴツメット', mon('garchomp', { moves: ['closecombat'], hp: 1 }), mon('kingambit', { item: 'rockyhelmet', hp: 1, moves: ['calmmind'] }), '攻撃側（p1）が後に倒れる'],
    ['さめはだ', mon('lucario', { moves: ['closecombat'], hp: 1 }), mon('garchomp', { ability: 'roughskin', hp: 1, moves: ['calmmind'], evs: { hp: 2, atk: 0, def: 0, spa: 0, spd: 32, spe: 0 } }), '攻撃側（p1）が後に倒れる'],
  ];
  const rows: string[] = []; let ok = true; const fps: string[] = [];
  for (const [name, a, b] of cases) {
    const pos: Position = { sides: [
      { mons: [a, mon('clefable', { hp: 0 }), mon('metagross', { hp: 0 })], active: 0 },
      { mons: [b, mon('gyarados', { hp: 0 }), mon('incineroar', { hp: 0 })], active: 0 },
    ] };
    const r = runner(pos, 1); r.play(mv(0), mv(0));
    const o = r.outcome();
    let order = '';
    if (mode === 'ref') {
      const log = logOf(r).filter(l => l.startsWith('|faint|'));
      order = log.map(l => l.split('|')[2]).join(' → ');
    }
    const both = o.sides[0].mons[0].hp === 0 && o.sides[1].mons[0].hp === 0;
    rows.push(`${name}：両方倒れた=${both}、勝ち=${o.winner === 0 ? 'p1' : o.winner === 1 ? 'p2' : 'なし'}${order ? `、倒れた順 ${order}` : ''}`);
    if (!both || o.winner !== 0) ok = false;
    fps.push(fp(r));
  }
  record('simulfaint', '最後の1体どうしが同時に倒れたとき', '後に倒れた側の勝ち', { 結果: rows }, ok, fps);
}

// 11. 決着したら、そのターンの残りの行動は行わない
{
  const pos: Position = { sides: [
    { mons: [mon('garchomp', { moves: ['earthquake'], status: 'brn', hp: 100, item: 'leftovers' }), mon('clefable', { hp: 0 }), mon('metagross', { hp: 0 })], active: 0 },
    { mons: [mon('metagross', { moves: ['earthquake'], hp: 1, evs: { hp: 2, atk: 32, def: 0, spa: 0, spd: 0, spe: 0 } }), mon('gyarados', { hp: 0 }), mon('incineroar', { hp: 0 })], active: 0 },
  ] };
  const fps: string[] = []; let ok = true; const rows: string[] = [];
  for (let s = 1; s <= 20; s++) {
    const r = runner(pos, s); r.play(mv(0), mv(0));
    const o = r.outcome();
    if (!(o.ended && o.winner === 0 && o.sides[0].mons[0].hp === 100)) ok = false;
    if (s === 1) {
      rows.push(`決着=${o.ended}、勝ち=${o.winner === 0 ? 'p1' : 'p2'}、やけど・たべのこしのガブリアスのHP=${o.sides[0].mons[0].hp}（決着前100）`);
      if (mode === 'ref') rows.push(`メタグロスの技が記録にあるか：${logOf(r).some(l => l.startsWith('|move|p2a'))}`);
    }
    fps.push(fp(r));
  }
  record('endstop', '決着した時点で、そのターンの残りの行動は行わない', '先に動いて最後の1体を倒したら、後の技・やけど・たべのこしは起きない', { 結果: rows }, ok, fps);
}

mkdirSync('.build', { recursive: true });
writeFileSync(`.build/rules-${mode}.json`, JSON.stringify(results, null, 1));
