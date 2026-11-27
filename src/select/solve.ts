// 読み合いで釣り合う選び方（2人ゼロ和の行列ゲームの解）を、線形計画法で求める。
// 表 A[i][j] は「こちらが行 i、相手が列 j を選んだときの、こちらの勝率」。こちらは勝率を大きく、相手は小さくしたい。
// 解き方：表の値に定数を足して正にし、相手側の問題「最大化 Σy  条件 A'y ≤ 1, y ≥ 0」を単体法で解く。
// 最後の表の、余裕の変数の欄からこちら側の答えも出る（双対）。値 v = 1/Σy − 足した定数。

export interface GameSolution {
  value: number;   // 釣り合ったときのこちらの勝率
  row: number[];   // こちらの確率（行ごと）
  col: number[];   // 相手の確率（列ごと）
}

/** 表全体を解く。 */
export function solveMatrix(A: number[][]): GameSolution {
  const m = A.length, n = A[0]?.length ?? 0;
  if (!m || !n) throw new Error('表が空です');
  let min = Infinity;
  for (const r of A) for (const x of r) { if (!Number.isFinite(x)) throw new Error('表に数でない値があります'); min = Math.min(min, x); }
  const shift = 1 - min;   // 足したあとの値は1以上
  // 単体表：行 0..m-1 が条件（変数 y_0..y_{n-1}、余裕 s_0..s_{m-1}、右辺）、最後の行が目的
  const W = n + m + 1;
  const T: Float64Array[] = [];
  for (let i = 0; i < m; i++) {
    const r = new Float64Array(W);
    for (let j = 0; j < n; j++) r[j] = A[i][j] + shift;
    r[n + i] = 1; r[W - 1] = 1;
    T.push(r);
  }
  const obj = new Float64Array(W);
  for (let j = 0; j < n; j++) obj[j] = -1;
  const basis = Array.from({ length: m }, (_, i) => n + i);
  // 0 とみなす幅。小さすぎると、計算の誤差で 0 に近い数で割り、同じ所を回り続ける（2026-11-27 に本物の表で起きた）
  const EPS = 1e-9;
  let lastObj = obj[W - 1], stall = 0;
  for (let it = 0; it < 50000; it++) {
    // 入る変数：ふだんは目的がいちばん大きく改善するもの。目的が進まない回が続いたら、番号が小さいもの（ブランドの規則）に切り替える
    const bland = stall > 50;
    let e = -1, most = -EPS;
    for (let j = 0; j < W - 1; j++) {
      if (obj[j] < most) { e = j; if (bland) break; most = obj[j]; }
    }
    if (e < 0) break;
    // 出る変数：比の最小。比が同じなら、ふだんは割る数の大きいもの（誤差が小さい）、ブランドの規則のときは基底の番号が小さいもの
    let l = -1, best = Infinity;
    for (let i = 0; i < m; i++) {
      const a = T[i][e];
      if (a <= EPS) continue;
      const ratio = T[i][W - 1] / a;
      if (l < 0 || ratio < best - 1e-12) { best = ratio; l = i; continue; }
      if (Math.abs(ratio - best) <= 1e-12 && (bland ? basis[i] < basis[l] : a > T[l][e])) { best = ratio; l = i; }
    }
    if (l < 0) throw new Error('解が有界でない（起こらないはず）');
    const piv = T[l][e];
    for (let j = 0; j < W; j++) T[l][j] /= piv;
    for (let i = 0; i < m; i++) if (i !== l) {
      const f = T[i][e]; if (f === 0) continue;
      for (let j = 0; j < W; j++) T[i][j] -= f * T[l][j];
      if (T[i][W - 1] < 0) T[i][W - 1] = 0;   // 誤差でわずかに負になった右辺を 0 に戻す
    }
    { const f = obj[e]; for (let j = 0; j < W; j++) obj[j] -= f * T[l][j]; }
    basis[l] = e;
    if (obj[W - 1] > lastObj + 1e-12) { lastObj = obj[W - 1]; stall = 0; } else stall++;
  }
  const y = new Array(n).fill(0);
  for (let i = 0; i < m; i++) if (basis[i] < n) y[basis[i]] = Math.max(0, T[i][W - 1]);
  const x = Array.from({ length: m }, (_, i) => Math.max(0, obj[n + i]));
  const sy = y.reduce((a, b) => a + b, 0), sx = x.reduce((a, b) => a + b, 0);
  const row = x.map(v => v / sx), col = y.map(v => v / sy);
  // 答えの確かめ：こちらの確率で必ず取れる値（下）と、相手の確率に対してこちらが取れる最大（上）は、解なら一致する
  let lower = Infinity, upper = -Infinity;
  for (let j = 0; j < n; j++) { let v = 0; for (let i = 0; i < m; i++) v += row[i] * A[i][j]; lower = Math.min(lower, v); }
  for (let i = 0; i < m; i++) { let v = 0; for (let j = 0; j < n; j++) v += col[j] * A[i][j]; upper = Math.max(upper, v); }
  if (!(upper - lower < 1e-6)) throw new Error(`釣り合いを解けませんでした（下 ${lower}、上 ${upper}）`);
  return { value: (lower + upper) / 2, row, col };
}

/** こちらの確率 row に対する相手の一番よい列と、そのときの勝率（相手は小さくしたい）。 */
export function bestCol(A: (i: number, j: number) => number, rows: number[], row: number[], cols: number[]) {
  let best = -1, bestV = Infinity;
  for (const j of cols) {
    let v = 0;
    rows.forEach((i, k) => { if (row[k] > 0) v += row[k] * A(i, j); });
    if (v < bestV) { bestV = v; best = j; }
  }
  return { j: best, v: bestV };
}

/** 相手の確率 col に対するこちらの一番よい行と、そのときの勝率。 */
export function bestRow(A: (i: number, j: number) => number, rows: number[], cols: number[], col: number[]) {
  let best = -1, bestV = -Infinity;
  for (const i of rows) {
    let v = 0;
    cols.forEach((j, k) => { if (col[k] > 0) v += col[k] * A(i, j); });
    if (v > bestV) { bestV = v; best = i; }
  }
  return { i: best, v: bestV };
}

export interface OracleResult extends GameSolution {
  rows: number[]; cols: number[];   // 使った行と列（row / col はこの並びの確率）
  lower: number; upper: number;     // 本当の値はこの間にある（表の値が正しいとき）
  rounds: number;
}

/**
 * 必要な行と列だけ足していく方法（ダブルオラクル）。A(i, j) は必要になったマスだけ呼ばれる。
 * 今の部分の表で解き、全部の行・列の中から一番よい応手を探し、部分の表になければ足す。差が tol 以下で止める。
 */
export function doubleOracle(A: (i: number, j: number) => number, m: number, n: number, opt: { tol?: number; startRow?: number; startCol?: number; maxRounds?: number } = {}): OracleResult {
  const tol = opt.tol ?? 1e-9;
  const rows = [opt.startRow ?? 0], cols = [opt.startCol ?? 0];
  const all = (k: number) => Array.from({ length: k }, (_, i) => i);
  const allRows = all(m), allCols = all(n);
  let sol: GameSolution = { value: A(rows[0], cols[0]), row: [1], col: [1] };
  let lower = -Infinity, upper = Infinity, rounds = 0;
  for (; rounds < (opt.maxRounds ?? 1000); rounds++) {
    sol = solveMatrix(rows.map(i => cols.map(j => A(i, j))));
    const br = bestRow(A, allRows, cols, sol.col), bc = bestCol(A, rows, sol.row, allCols);
    upper = br.v; lower = bc.v;   // こちらの今の確率で必ず取れる値 ≤ 本当の値 ≤ 相手の今の確率でこちらが取れる最大
    let added = false;
    if (br.v > sol.value + tol && !rows.includes(br.i)) { rows.push(br.i); added = true; }
    if (bc.v < sol.value - tol && !cols.includes(bc.j)) { cols.push(bc.j); added = true; }
    if (!added) break;
  }
  return { ...sol, rows, cols, lower, upper, rounds };
}
