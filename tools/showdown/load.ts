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

/**
 * 別の写しの Showdown を読み込む（クラスや図鑑のデータが loadShowdown() と別のもの）。
 * 速さの層（記録を作らない）を当てる写しと、記録を作る写しを、同じ処理の中で使い分けるため。
 */
export function loadShowdownCopy(): any {
  const require = createRequire(import.meta.url);
  const saved: Record<string, any> = {};
  for (const k of Object.keys(require.cache)) if (k.startsWith(DIST)) { saved[k] = require.cache[k]; delete require.cache[k]; }
  const copy = loadShowdown();
  // 新しい写しの登録を消して、もとの写しを戻す（以後の loadShowdown() はもとの写しを返す）
  for (const k of Object.keys(require.cache)) if (k.startsWith(DIST)) delete require.cache[k];
  Object.assign(require.cache, saved);
  return copy;
}
