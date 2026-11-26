// vendor/showdown に組み立てた Showdown を読み込む（npm run showdown:setup が先に必要）。
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '../..');
export const FORMAT = 'gen9championsbssregmc';
const DIST = resolve(ROOT, 'vendor/showdown/dist');

export function loadShowdown(): any {
  if (!existsSync(DIST)) throw new Error('Showdown がありません。先に npm run showdown:setup を実行してください。');
  const require = createRequire(import.meta.url);
  const sim = require(resolve(DIST, 'sim/index.js'));
  const state = require(resolve(DIST, 'sim/state.js'));
  return { ...sim, State: state.State };
}

export function showdownCommit(): string {
  return readFileSync(resolve(import.meta.dirname, 'COMMIT'), 'utf8').trim();
}
