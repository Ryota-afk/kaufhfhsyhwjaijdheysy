// 照合の「エンジン側」：速さの層を当てた Showdown で、盤面を作ったあと複製し、複製の上で打つ。
import { parentPort, workerData } from 'node:worker_threads';
import { loadShowdown, FORMAT } from '../showdown/load.ts';
import { applySpeedLayer } from '../../src/engine/fast.ts';
import { makeCloner } from '../../src/engine/clone.ts';
import { runJob, type Job } from './play.ts';

const PS = loadShowdown();
const cfg = workerData ?? { layer: { noLog: true, events: true, activeMove: true }, clone: true };
applySpeedLayer(PS, PS.Battle, FORMAT, cfg.layer);
const clone = makeCloner(PS.Dex.forFormat(FORMAT));

// 照合の仕組みの確かめ用：わざと誤りを入れる（COMPARE_INJECT=spikes で、まきびしを層の数によらず1/8にする）
if (process.env.COMPARE_INJECT === 'spikes') {
  const orig = PS.Battle.prototype.damage;
  PS.Battle.prototype.damage = function (this: any, d: number, target: any, source: any, effect: any) {
    if ((effect ?? this.effect)?.id === 'spikes') d = (target ?? this.event.target).maxhp / 8;
    return orig.call(this, d, target, source, effect);
  };
}

parentPort!.on('message', (jobs: Job[]) => {
  const logs: string[][] = [];
  const res = jobs.map(job => runJob(job, cfg.clone ? (r => { r.battle = clone(r.battle); }) : undefined,
    cfg.wantLog ? (r => { logs.push(r.battle.log); }) : undefined));
  if (cfg.wantLog) (res as any).logs = logs;
  if (cfg.wantLog) { parentPort!.postMessage({ res, logs }); return; }
  parentPort!.postMessage(res);
});
