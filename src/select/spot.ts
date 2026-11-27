// その場の選出の計算：保存した表（なければ近い構築からの見積もり）を出発点に、時間の中で、答えを左右するマスに試合を足していく。
import { nextWork, solveTable, SIZE, type TableStats, type TableSolution } from './table.ts';

export interface SpotOptions {
  stats: TableStats;                       // 保存した表の試合数（なければ空）。この関数が書き足す
  prior?: (k: number) => number;          // 試合のないマスの見積もり
  timeMs: number;
  workers: number;                         // 同時に打つ試合の数
  play: (r: number, c: number, seed: number) => Promise<number>;   // 1試合（こちらの勝ち 1、負け 0）
  levels?: number[];
  onProgress?: (games: number) => void;   // 1試合ごと
  cancelled?: () => boolean;               // 入力が変わったら途中でやめる
}

export async function spotSolve(o: SpotOptions): Promise<{ sol: TableSolution; games: number; ms: number }> {
  const t0 = performance.now(), deadline = t0 + o.timeMs;
  const levels = o.levels ?? [2, 4, 8, 16, 32, 64, 128];
  let games = 0;
  const live = () => performance.now() < deadline && !o.cancelled?.();
  while (live()) {
    // 試合のないマスは見積もり（prior）で埋まっている前提なので、全部のマスを打つ段階は飛ばす（n0 = 0）
    const work = nextWork(o.stats, 0, levels, o.prior);
    if (work.done) break;
    const jobs: number[] = [];
    for (const [k, need] of work.need) for (let i = 0; i < need; i++) jobs.push(k);
    // 同じ段階の中では、試合の少ないマスから打つ
    jobs.sort((a, b) => o.stats.n[a] - o.stats.n[b]);
    let next = 0;
    const runOne = async (): Promise<void> => {
      while (next < jobs.length && live()) {
        const k = jobs[next++];
        const v = await o.play(Math.floor(k / SIZE), k % SIZE, (k * 104729 + o.stats.n[k] * 15485863 + games + 1) >>> 0);
        o.stats.n[k]++; o.stats.w[k] += v; games++;
        o.onProgress?.(games);
      }
    };
    await Promise.all(Array.from({ length: o.workers }, runOne));
  }
  return { sol: solveTable(o.stats, o.prior), games, ms: performance.now() - t0 };
}
