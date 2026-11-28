// 対戦中の判断：同時手番用のモンテカルロ木探索（DUCT：両者がそれぞれ自分の勝率で手を選ぶ）。
// 相手の見えない型は、呼び出し側が何通りか仮に決めた盤面（determinization）として渡す。盤面ごとに木を作り、根元の統計を足し合わせる。
// 盤面の良し悪しは、手作りの評価（evaluate）で測る。先読みは depth ターンまで。
// Showdown 本体（速さの層を当てたもの）と複製の関数を外から受け取る。
export interface SearchOptions {
  timeMs: number;          // この時間で打ち切る
  maxIters?: number;       // 回数の上限（テスト用）
  c?: number;              // 広げ方の定数（UCB1）。指示文の過去の実装の目安は0.7
  depth?: number;          // 先読みのターン数の上限
  rand?: () => number;
}
export interface ActionStat { choice: string; n: number; w: number }
export interface SearchResult { iters: number; perRoot: number[]; ours: ActionStat[]; theirs: ActionStat[] }

interface Stat { n: number; w: number }
interface Node {
  n: number;
  acts: [string[], string[]] | null;
  stats: [Map<string, Stat>, Map<string, Stat>];
  children: Map<string, Node>;
}
const newNode = (): Node => ({ n: 0, acts: null, stats: [new Map(), new Map()], children: new Map() });

/** 今の要求に対して選べる行動（Showdown の選び方の文字列）。待つだけなら [''] */
export function legalChoices(side: any): string[] {
  const req = side.activeRequest;
  if (!req || req.wait) return [''];
  const out: string[] = [];
  if (req.forceSwitch) {
    side.pokemon.forEach((p: any, k: number) => { if (k >= 1 && !p.fainted) out.push(`switch ${k + 1}`); });
    return out.length ? out : ['pass'];
  }
  const act = req.active[0];
  act.moves.forEach((m: any, k: number) => {
    if (m.disabled) return;
    out.push(`move ${k + 1}`);
    if (act.canMegaEvo) out.push(`move ${k + 1} mega`);
  });
  if (!act.trapped) side.pokemon.forEach((p: any, k: number) => { if (k >= 1 && !p.fainted) out.push(`switch ${k + 1}`); });
  return out.length ? out : ['default'];
}

/** 両者の行動を打ち、途中の交代（倒れた後など）は rand で選んで、次のターンの選択か決着まで進める。 */
export function step(b: any, c0: string, c1: string, rand: () => number) {
  if (c0) b.choose('p1', c0);
  if (c1) b.choose('p2', c1);
  for (let guard = 0; guard < 6 && !b.ended && b.requestState === 'switch'; guard++) {
    for (const side of b.sides) {
      const req = side.activeRequest;
      if (!req || req.wait || !req.forceSwitch) continue;
      const opts = legalChoices(side);
      b.choose(side.id, opts[Math.floor(rand() * opts.length)]);
    }
  }
}

/** 盤面の良し悪し：p1 が勝つ見込み（0〜1）。残りのポケモンの数とHPの割合、状態異常、能力ランクから。 */
export function evaluate(b: any): number {
  if (b.ended) return b.winner === b.sides[0].name ? 1 : b.winner === b.sides[1].name ? 0 : 0.5;
  const score = (side: any) => {
    let s = 0;
    for (const p of side.pokemon) {
      if (p.fainted || p.hp <= 0) continue;
      s += 0.5 + 0.5 * p.hp / p.maxhp;
      if (p.status && p.status !== 'fnt') s -= p.status === 'slp' || p.status === 'frz' ? 0.15 : 0.08;
      if (p.isActive) for (const k of ['atk', 'spa', 'spe']) s += 0.03 * Math.max(-3, Math.min(3, p.boosts[k]));
    }
    return s;
  };
  const d = score(b.sides[0]) - score(b.sides[1]);
  return 1 / (1 + Math.exp(-1.6 * d));
}

function select(node: Node, side: 0 | 1, c: number, rand: () => number): string {
  const acts = node.acts![side];
  if (acts.length === 1) return acts[0];
  const stats = node.stats[side];
  const unvisited = acts.filter(a => !stats.get(a)?.n);
  if (unvisited.length) return unvisited[Math.floor(rand() * unvisited.length)];
  const lnN = Math.log(node.n);
  let best = acts[0], bestV = -Infinity;
  for (const a of acts) {
    const st = stats.get(a)!;
    const v = st.w / st.n + c * Math.sqrt(lnN / st.n);
    if (v > bestV) { bestV = v; best = a; }
  }
  return best;
}

/**
 * roots：仮に決めた盤面ごとの Showdown の Battle（p1 がこちら）。clone：速い複製。
 * 戻り値の ours / theirs は、全部の盤面の根元の統計を足したもの（w は p1 から見た勝ちの合計。theirs も p1 から見た値）。
 */
export function search(roots: any[], clone: (b: any) => any, opt: SearchOptions): SearchResult {
  const c = opt.c ?? 0.7, depth = opt.depth ?? 4, rand = opt.rand ?? Math.random;
  const trees = roots.map(() => newNode());
  const perRoot = roots.map(() => 0);
  const deadline = performance.now() + opt.timeMs;
  let iters = 0;
  while (iters < (opt.maxIters ?? Infinity)) {
    if ((iters & 7) === 0 && performance.now() > deadline) break;
    const r = iters % roots.length;
    const b = clone(roots[r]);
    let node = trees[r];
    const path: [Node, string, string][] = [];
    let value: number | null = null;
    for (let d = 0; ; d++) {
      if (b.ended || d >= depth) { value = evaluate(b); break; }
      if (!node.acts) node.acts = [legalChoices(b.sides[0]), legalChoices(b.sides[1])];
      const a0 = select(node, 0, c, rand), a1 = select(node, 1, c, rand);
      // p2 は自分の勝ち（1 - p1 の勝ち）で選ぶので、統計は p1 から見た値のまま持ち、選ぶときに反転する
      path.push([node, a0, a1]);
      step(b, a0, a1, rand);
      const key = a0 + '|' + a1;
      let child = node.children.get(key);
      if (!child) { child = newNode(); node.children.set(key, child); node = child; value = evaluate(b); break; }
      node = child;
    }
    for (const [nd, a0, a1] of path) {
      nd.n++;
      const s0 = nd.stats[0].get(a0) ?? { n: 0, w: 0 }; s0.n++; s0.w += value!; nd.stats[0].set(a0, s0);
      const s1 = nd.stats[1].get(a1) ?? { n: 0, w: 0 }; s1.n++; s1.w += 1 - value!; nd.stats[1].set(a1, s1);
    }
    perRoot[r]++;
    iters++;
  }
  const merge = (side: 0 | 1) => {
    const m = new Map<string, Stat>();
    for (const t of trees) for (const [a, st] of t.stats[side]) { const x = m.get(a) ?? { n: 0, w: 0 }; x.n += st.n; x.w += side === 0 ? st.w : st.n - st.w; m.set(a, x); }
    return [...m.entries()].map(([choice, s]) => ({ choice, n: s.n, w: s.w })).sort((x, y) => y.n - x.n);
  };
  return { iters, perRoot, ours: merge(0), theirs: merge(1) };
}

/** 結果を上位3手と勝率・誤差にする。差が誤差（2つの標準誤差を合わせたものの2倍）より小さいときは close を立てる。 */
export function top3(stats: ActionStat[]) {
  const rows = stats.filter(s => s.n > 0).slice(0, 3).map(s => {
    const p = s.w / s.n;
    return { choice: s.choice, n: s.n, winRate: p, se: Math.sqrt(Math.max(p * (1 - p), 0.01) / s.n) };
  });
  return rows.map((r, i) => ({ ...r, closeToNext: i + 1 < rows.length && Math.abs(r.winRate - rows[i + 1].winRate) < 2 * Math.hypot(r.se, rows[i + 1].se) }));
}
