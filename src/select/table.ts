// 選出の表（こちら60行×相手60列）の数え方と、どのマスに試合を足すかの決め方。先回りの計算とブラウザの両方で使う。
import { solveMatrix, type GameSolution } from './solve.ts';

export const SIZE = 60;
export interface TableStats { n: number[]; w: number[] }   // マス r*60+c の試合数と、こちらの勝ちの数（決着なしは0.5）

export const emptyStats = (): TableStats => ({ n: new Array(SIZE * SIZE).fill(0), w: new Array(SIZE * SIZE).fill(0) });

/** マスの勝率の見積もり。試合のないマスは prior（なければ0.5）。少ない試合は prior の側へ寄せる（重み2試合分）。 */
export function estimate(s: TableStats, prior?: (k: number) => number): number[][] {
  const A: number[][] = [];
  for (let r = 0; r < SIZE; r++) {
    const row: number[] = [];
    for (let c = 0; c < SIZE; c++) {
      const k = r * SIZE + c, p0 = prior ? prior(k) : 0.5;
      row.push((s.w[k] + 2 * p0) / (s.n[k] + 2));
    }
    A.push(row);
  }
  return A;
}

export interface TableSolution extends GameSolution { support: { rows: number[]; cols: number[] } }

/** 表全体を解く。確率が minP 以上の行・列を「使われる手」とする。 */
export function solveTable(s: TableStats, prior?: (k: number) => number, minP = 0.01): TableSolution {
  const sol = solveMatrix(estimate(s, prior));
  const rows = sol.row.map((p, i) => p >= minP ? i : -1).filter(i => i >= 0);
  const cols = sol.col.map((p, j) => p >= minP ? j : -1).filter(j => j >= 0);
  return { ...sol, support: { rows, cols } };
}

/** 答えを左右するマス：使われるこちらの行の全部の列と、使われる相手の列の全部の行。 */
export function importantCells(sol: TableSolution): number[] {
  const set = new Set<number>();
  for (const r of sol.support.rows) for (let c = 0; c < SIZE; c++) set.add(r * SIZE + c);
  for (const c of sol.support.cols) for (let r = 0; r < SIZE; r++) set.add(r * SIZE + c);
  return [...set];
}

/**
 * 次に試合を足すマス。まず全部のマスを n0 試合にする。その後は、答えを左右するマスを levels の順に増やす。
 * 戻り値の need はマスごとの足りない試合数。全部の段階を満たしたら done。
 */
export function nextWork(s: TableStats, n0: number, levels: number[], prior?: (k: number) => number): { need: Map<number, number>; level: number; done: boolean; sol?: TableSolution } {
  const need = new Map<number, number>();
  for (let k = 0; k < SIZE * SIZE; k++) if (s.n[k] < n0) need.set(k, n0 - s.n[k]);
  if (need.size) return { need, level: n0, done: false };
  const sol = solveTable(s, prior);
  const imp = importantCells(sol);
  for (const lv of levels) {
    for (const k of imp) if (s.n[k] < lv) need.set(k, lv - s.n[k]);
    if (need.size) return { need, level: lv, done: false, sol };
  }
  return { need, level: levels[levels.length - 1] ?? n0, done: true, sol };
}
