// 探索の Worker：速さの層を当てた Showdown で、渡された盤面（仮に決めた相手の型ごと）を探索する。
import { PS } from '@showdown';
import { applySpeedLayer } from '../fast.ts';
import { makeCloner } from '../clone.ts';
import { makeRunner } from '../runner.ts';
import { search } from '../../search/mcts.ts';

const FORMAT = 'gen9championsbssregmc';
applySpeedLayer(PS, PS.Battle, FORMAT);
const clone = makeCloner(PS.Dex.forFormat(FORMAT), PS.Pokemon);
const Runner = makeRunner(PS, FORMAT);

self.onmessage = (ev: MessageEvent) => {
  const msg = ev.data;
  try {
    if (msg.type === 'search') {
      let s = msg.seed >>> 0 || 1;
      const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
      const roots = msg.positions.map((p: any, i: number) => new Runner(p, (msg.seed + i) >>> 0).battle);
      const r = search(roots, clone, { timeMs: msg.timeMs, c: msg.c, depth: msg.depth, rand });
      (self as any).postMessage({ type: 'search', ...r });
    }
  } catch (e: any) {
    (self as any).postMessage({ type: 'error', message: String(e?.stack ?? e) });
  }
};
(self as any).postMessage({ type: 'ready' });
