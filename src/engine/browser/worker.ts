// ブラウザの Web Worker で Showdown を動かす。
// 最初の 'init' で、速さの層を当てるかを決める（当てると同じ Worker の中では外せない）。
import { PS } from '@showdown';
import { applySpeedLayer } from '../fast.ts';
import { makeCloner } from '../clone.ts';
import { makeRunner } from '../runner.ts';
import { runJobWith, type Job } from '../play.ts';
import { runBench, runIterBench } from '../bench-core.ts';

const FORMAT = 'gen9championsbssregmc';
let layer = false;
let clone: (b: any) => any = (b: any) => b;
let Runner: any = null;

self.onmessage = (ev: MessageEvent) => {
  const msg = ev.data;
  try {
    if (msg.type === 'init') {
      layer = !!msg.layer;
      if (layer) applySpeedLayer(PS, PS.Battle, FORMAT);
      clone = makeCloner(PS.Dex.forFormat(FORMAT), PS.Pokemon);
      Runner = makeRunner(PS, FORMAT);
      (self as any).postMessage({ type: 'ready', layer });
    } else if (msg.type === 'jobs') {
      const jobs: Job[] = msg.jobs;
      const res = jobs.map(job => runJobWith(Runner, job, layer ? (r: any) => { r.battle = clone(r.battle); } : undefined));
      (self as any).postMessage({ type: 'jobs', res });
    } else if (msg.type === 'iter') {
      const r = runIterBench(PS, FORMAT, msg.teams, msg.seconds, clone);
      (self as any).postMessage({ type: 'iter', layer, ...r });
    } else if (msg.type === 'bench') {
      const r = runBench(PS, FORMAT, msg.teams, msg.seconds, clone);
      (self as any).postMessage({ type: 'bench', layer, ...r });
    }
  } catch (e: any) {
    (self as any).postMessage({ type: 'error', message: String(e?.stack ?? e) });
  }
};
