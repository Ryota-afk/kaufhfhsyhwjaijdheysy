// 設定の比べの手伝い：渡された1試合（src/learn/duel.ts）を打って、結果を返す。
import { parentPort } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { loadShowdown, loadShowdownCopy, FORMAT } from '../showdown/load.ts';
import { applySpeedLayer } from '../../src/engine/fast.ts';
import { makeCloner } from '../../src/engine/clone.ts';
import { makeRunner } from '../../src/engine/runner.ts';
import { makeAnalyzer } from '../../src/battle/analyze.ts';
import { playDuel } from '../../src/learn/duel.ts';

// 記録を作る写し（本当の対戦と記録係）と、速さの層を当てた写し（探索）を分ける
const PS = loadShowdown(), FAST = loadShowdownCopy();
if (PS.Battle === FAST.Battle) throw new Error('Showdown の写しが分かれていません');
applySpeedLayer(FAST, FAST.Battle, FORMAT);
const dex = PS.Dex.forFormat(FORMAT);
// 推定の最初の確率は、上位構築のデータだけ（対戦記録の割合は混ぜない。比べを毎回同じ条件にするため）
const Analyzer = makeAnalyzer(PS, FORMAT, JSON.parse(readFileSync('data/priors/sets.json', 'utf8')), JSON.parse(readFileSync('data/seed/teams_m7.json', 'utf8')), JSON.parse(readFileSync('data/seed/selections_m7.json', 'utf8')));
const env = { dex, Runner: makeRunner(PS, FORMAT), FastRunner: makeRunner(FAST, FORMAT), clone: makeCloner(FAST.Dex.forFormat(FORMAT), FAST.Pokemon), Analyzer };

parentPort!.on('message', (m: any) => {
  try { parentPort!.postMessage({ key: m.key, ...playDuel(env, m.duel) }); }
  catch (e: any) { parentPort!.postMessage({ key: m.key, error: String(e?.message ?? e) }); }
});
parentPort!.postMessage({ ready: true });
