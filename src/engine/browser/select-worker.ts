// 選出の表のその場の計算の Worker：渡されたマスの試合を1つずつ打って返す（先回りの計算と同じ AI）。
import { PS } from '@showdown';
import { applySpeedLayer } from '../fast.ts';
import { makeCloner } from '../clone.ts';
import { playCell } from '../../select/cell.ts';

const FORMAT = 'gen9championsbssregmc';
applySpeedLayer(PS, PS.Battle, FORMAT);
const clone = makeCloner(PS.Dex.forFormat(FORMAT), PS.Pokemon);

self.onmessage = (ev: MessageEvent) => {
  const m = ev.data;
  try {
    const v = playCell(PS, FORMAT, clone, m.ours, m.theirs, m.r, m.c, m.iters, m.seed);
    (self as any).postMessage({ type: 'game', r: m.r, c: m.c, v });
  } catch (e: any) {
    (self as any).postMessage({ type: 'error', r: m.r, c: m.c, message: String(e?.message ?? e) });
  }
};
(self as any).postMessage({ type: 'ready' });
