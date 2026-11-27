// 速さの測定の中身（Node とブラウザで共通）。
// 上位構築どうしでランダムな行動の対戦を回し、1秒あたりのターン数（準備の時間を除く）と、対戦途中の盤面の複製1回の時間を測る。
export interface BenchResult { games: number; turns: number; turnsPerSec: number; cloneUs: number; clones: number }

export function runBench(PS: any, FORMAT: string, teams: any[], seconds: number, clone: (b: any) => any): BenchResult {
  const toSets = (t: any) => t.mons.map((m: any) => ({ name: '', species: m.species, item: m.item, ability: m.ability, nature: m.nature, evs: m.evs, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }, moves: m.moves, level: 50, gender: '' }));
  let st = 7; const rnd = (n: number) => { st = (st * 1103515245 + 12345) & 0x7fffffff; return st % n; };
  const choose = (b: any, side: any) => {
    const req = side.activeRequest; if (!req || req.wait) return;
    const opts: string[] = [];
    if (req.forceSwitch) { side.pokemon.forEach((p: any, i: number) => { if (i > 0 && !p.fainted) opts.push('switch ' + (i + 1)); }); b.choose(side.id, opts.length ? opts[rnd(opts.length)] : 'pass'); return; }
    const act = req.active[0];
    act.moves.forEach((m: any, i: number) => { if (!m.disabled) opts.push('move ' + (i + 1)); });
    if (!act.trapped) side.pokemon.forEach((p: any, i: number) => { if (i > 0 && !p.fainted) opts.push('switch ' + (i + 1)); });
    if (!opts.length || !b.choose(side.id, opts[rnd(opts.length)])) b.choose(side.id, 'default');
  };
  let turns = 0, games = 0, simMs = 0, clones = 0, cloneMs = 0;
  const end = performance.now() + seconds * 1000;
  while (performance.now() < end) {
    const b = new PS.Battle({ formatid: FORMAT, seed: [rnd(65535), rnd(65535), rnd(65535), rnd(65535)].join(',') });
    b.setPlayer('p1', { name: 'a', team: PS.Teams.pack(toSets(teams[rnd(teams.length)])) });
    b.setPlayer('p2', { name: 'b', team: PS.Teams.pack(toSets(teams[rnd(teams.length)])) });
    b.choose('p1', 'team 123'); b.choose('p2', 'team 123');
    let guard = 0;
    const t0 = performance.now();
    while (!b.ended && guard++ < 200) {
      const t = b.turn; choose(b, b.p1); choose(b, b.p2); if (b.turn !== t) turns++;
      if (b.turn === 3 && guard < 10) {
        // 対戦途中の盤面を20回複製して時間を測る（この時間は対戦の時間から外す）
        const c0 = performance.now(); for (let k = 0; k < 20; k++) clone(b); const dc = performance.now() - c0;
        cloneMs += dc; clones += 20; simMs -= dc;
      }
    }
    simMs += performance.now() - t0;
    games++;
  }
  return { games, turns, turnsPerSec: turns / simMs * 1000, cloneUs: clones ? cloneMs / clones * 1000 : 0, clones };
}

/**
 * 探索1回に相当する処理（対戦途中の盤面を複製し、ランダムな行動で最大2ターン打つ）が、1秒に何回回るか。
 * 実際の探索（段階4）の1回はこれに近い中身になる見込み（複製＋1〜2ターン＋評価）。評価の計算は含まない。
 */
export function runIterBench(PS: any, FORMAT: string, teams: any[], seconds: number, clone: (b: any) => any): { iters: number; itersPerSec: number } {
  const toSets = (t: any) => t.mons.map((m: any) => ({ name: '', species: m.species, item: m.item, ability: m.ability, nature: m.nature, evs: m.evs, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }, moves: m.moves, level: 50, gender: '' }));
  let st = 11; const rnd = (n: number) => { st = (st * 1103515245 + 12345) & 0x7fffffff; return st % n; };
  const choose = (b: any, side: any) => {
    const req = side.activeRequest; if (!req || req.wait) return;
    const opts: string[] = [];
    if (req.forceSwitch) { side.pokemon.forEach((p: any, i: number) => { if (i > 0 && !p.fainted) opts.push('switch ' + (i + 1)); }); b.choose(side.id, opts.length ? opts[rnd(opts.length)] : 'pass'); return; }
    const act = req.active[0];
    act.moves.forEach((m: any, i: number) => { if (!m.disabled) opts.push('move ' + (i + 1)); });
    if (!act.trapped) side.pokemon.forEach((p: any, i: number) => { if (i > 0 && !p.fainted) opts.push('switch ' + (i + 1)); });
    if (!opts.length || !b.choose(side.id, opts[rnd(opts.length)])) b.choose(side.id, 'default');
  };
  // 根元にする盤面を用意（3ターン進めた盤面）
  const roots: any[] = [];
  while (roots.length < 30) {
    const b = new PS.Battle({ formatid: FORMAT, seed: [rnd(65535), rnd(65535), rnd(65535), rnd(65535)].join(',') });
    b.setPlayer('p1', { name: 'a', team: PS.Teams.pack(toSets(teams[rnd(teams.length)])) });
    b.setPlayer('p2', { name: 'b', team: PS.Teams.pack(toSets(teams[rnd(teams.length)])) });
    b.choose('p1', 'team 123'); b.choose('p2', 'team 123');
    let guard = 0;
    while (!b.ended && b.turn < 3 && guard++ < 20) { choose(b, b.p1); choose(b, b.p2); }
    if (!b.ended) roots.push(b);
  }
  let iters = 0;
  const t0 = performance.now(), end = t0 + seconds * 1000;
  while (performance.now() < end) {
    const c = clone(roots[iters % roots.length]);
    // 複製の乱数をずらす（同じ展開の繰り返しにしない）
    c.prng = new PS.PRNG([rnd(65535), rnd(65535), rnd(65535), rnd(65535)].join(','));
    const target = c.turn + 2;
    let guard = 0;
    while (!c.ended && c.turn < target && guard++ < 8) { choose(c, c.p1); choose(c, c.p2); }
    iters++;
  }
  return { iters, itersPerSec: iters / (performance.now() - t0) * 1000 };
}
