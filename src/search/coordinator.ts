// ブラウザで探索を並べて動かす。仮に決めた盤面を Worker に配り、時間で打ち切って、根元の統計を足し合わせる。
import type { Position } from '../engine/position.ts';
import { top3, type ActionStat } from './mcts.ts';

export class SearchPool {
  private workers: Worker[] = [];
  private ready: Promise<void>[] = [];
  constructor(n: number, make: () => Worker) {
    for (let i = 0; i < n; i++) {
      const w = make();
      this.workers.push(w);
      this.ready.push(new Promise((res, rej) => {
        w.onmessage = ev => { if (ev.data.type === 'ready') res(); else if (ev.data.type === 'error') rej(new Error(ev.data.message)); };
        w.onerror = e => rej(new Error(e.message));
      }));
    }
  }
  get size() { return this.workers.length; }
  async run(positions: Position[], timeMs: number, opt: { c?: number; depth?: number; seed?: number } = {}) {
    await Promise.all(this.ready);
    const n = Math.min(this.workers.length, positions.length);
    const parts: Position[][] = Array.from({ length: n }, () => []);
    positions.forEach((p, i) => parts[i % n].push(p));
    const t0 = performance.now();
    const results = await Promise.all(parts.map((ps, i) => new Promise<any>((res, rej) => {
      const w = this.workers[i];
      w.onmessage = ev => ev.data.type === 'error' ? rej(new Error(ev.data.message)) : res(ev.data);
      w.postMessage({ type: 'search', positions: ps, timeMs, c: opt.c ?? 0.7, depth: opt.depth ?? 4, seed: (opt.seed ?? Date.now()) + i * 7919 });
    })));
    const merge = (key: 'ours' | 'theirs') => {
      const m = new Map<string, ActionStat>();
      for (const r of results) for (const s of r[key] as ActionStat[]) { const x = m.get(s.choice) ?? { choice: s.choice, n: 0, w: 0 }; x.n += s.n; x.w += s.w; m.set(s.choice, x); }
      return [...m.values()].sort((a, b) => b.n - a.n);
    };
    const ours = merge('ours'), theirs = merge('theirs');
    return { iters: results.reduce((a, r) => a + r.iters, 0), ms: performance.now() - t0, ours, theirs, top: top3(ours) };
  }
  terminate() { this.workers.forEach(w => w.terminate()); }
}
