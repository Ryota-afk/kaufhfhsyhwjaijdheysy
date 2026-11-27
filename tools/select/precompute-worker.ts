// 先回りの計算の手伝い：渡されたマスの試合を1つずつ打って返す。
import { parentPort } from 'node:worker_threads';
import { loadShowdown, FORMAT } from '../showdown/load.ts';
import { applySpeedLayer } from '../../src/engine/fast.ts';
import { makeCloner } from '../../src/engine/clone.ts';
import { playCell } from '../../src/select/cell.ts';

const PS = loadShowdown(); applySpeedLayer(PS, PS.Battle, FORMAT);
const clone = makeCloner(PS.Dex.forFormat(FORMAT), PS.Pokemon);
parentPort!.on('message', (m: any) => {
  try {
    const v = playCell(PS, FORMAT, clone, m.ours, m.theirs, m.r, m.c, m.iters, m.seed);
    parentPort!.postMessage({ id: m.id, r: m.r, c: m.c, v });
  } catch (e: any) {
    parentPort!.postMessage({ id: m.id, r: m.r, c: m.c, error: String(e?.message ?? e) });
  }
});
parentPort!.postMessage({ ready: true });
