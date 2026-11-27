// 照合用：vendor/showdown の Showdown で、src/engine/play.ts の打ち方を使う。
import { ShowdownRunner } from './showdown-adapter.ts';
import { runJobWith, type Job, type RunResult } from '../../src/engine/play.ts';
export type { Job, RunResult };
export function runJob(job: Job, prepare?: (r: ShowdownRunner) => void, collect?: (r: ShowdownRunner) => void): RunResult[] {
  return runJobWith(ShowdownRunner, job, prepare, collect);
}
