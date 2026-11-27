// 盤面1つ・乱数の種1つで、決まった数のターンを打って結果を返す（照合の両側で同じ手順を使う）。
// Node にもブラウザにも依存しない。Runner（src/engine/runner.ts の makeRunner で作る）を外から渡す。
import type { Position, Action, Outcome } from './position.ts';

export interface Job { pos: Position; first: [Action, Action]; seeds: number[]; turns: number }
export interface RunResult { outcome?: Outcome; error?: string; moves: string[] }

/** 2ターン目以降の行動は、種とターン数から決まる番号で選ぶ（両側で同じ選び方になる）。 */
function pickIndex(seed: number, turn: number, si: number, n: number) {
  let h = (seed * 2654435761 + turn * 40503 + si * 9973) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995) >>> 0; h ^= h >>> 15;
  return h % n;
}

export function runJobWith(Runner: any, job: Job, prepare?: (r: any) => void, collect?: (r: any) => void): RunResult[] {
  const out: RunResult[] = [];
  for (const seed of job.seeds) {
    const moves: string[] = [];
    try {
      const r = new Runner(job.pos, seed);
      prepare?.(r);
      r.play(job.first[0], job.first[1]);
      for (let t = 1; t < job.turns && !r.battle.ended; t++) {
        const acts = [0, 1].map(si => { const l = r.legalActions(si); return l.length ? l[pickIndex(seed, t, si, l.length)] : null; });
        moves.push(JSON.stringify(acts));
        r.play(acts[0], acts[1]);
      }
      collect?.(r);
      out.push({ outcome: r.outcome(), moves });
    } catch (e: any) {
      out.push({ error: String(e?.message ?? e).slice(0, 200), moves });
    }
  }
  return out;
}
