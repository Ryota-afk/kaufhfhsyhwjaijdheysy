// 照合用：vendor/showdown の Showdown でエンジンの入口（src/engine/runner.ts）を作る。
import { loadShowdown, FORMAT } from '../showdown/load.ts';
import { makeRunner } from '../../src/engine/runner.ts';

export const ShowdownRunner = makeRunner(loadShowdown(), FORMAT);
export type ShowdownRunner = InstanceType<typeof ShowdownRunner>;
