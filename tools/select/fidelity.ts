// 選出の表のマスの見積もりが、AIの探索の回数でどれだけ変わるかを比べる（使うAIを決めるための測定）。
// 使い方：npx tsx tools/select/fidelity.ts <探索の回数> <1マスの試合数> <分担の番号> <分担の数> [マスの数=24] [相手の順位=1]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { loadShowdown, FORMAT } from '../showdown/load.ts';
import { applySpeedLayer } from '../../src/engine/fast.ts';
import { makeCloner } from '../../src/engine/clone.ts';
import { playCell } from '../../src/select/cell.ts';

const [K, N, SHARD, NSHARD, NCELLS, RANK] = [100, 40, 0, 1, 24, 1].map((d, i) => Number(process.argv[2 + i] ?? d));
const PS = loadShowdown(); applySpeedLayer(PS, PS.Battle, FORMAT);
const clone = makeCloner(PS.Dex.forFormat(FORMAT), PS.Pokemon);
const party = JSON.parse(readFileSync('data/parties/p202611270338021706.json', 'utf8')).mons;
const team = JSON.parse(readFileSync('data/seed/teams_m7.json', 'utf8')).find((t: any) => t.rank === RANK).mons;
// 決まった乱数でマスを選ぶ（回数を変えても同じマス）
let st = 99; const rand = () => { st = (st * 16807) % 2147483647; return st / 2147483647; };
const cells = Array.from({ length: NCELLS }, () => [Math.floor(rand() * 60), Math.floor(rand() * 60)]);
const out: any[] = [];
const t0 = Date.now();
cells.forEach(([r, c], k) => {
  if (k % NSHARD !== SHARD) return;
  let w = 0;
  for (let g = 0; g < N; g++) w += playCell(PS, FORMAT, clone, party, team, r, c, K, 1000 * k + g + 1);
  out.push({ k, r, c, n: N, w });
});
mkdirSync('.build', { recursive: true });
writeFileSync(`.build/fidelity-${K}-${SHARD}.json`, JSON.stringify({ K, N, seconds: (Date.now() - t0) / 1000, cells: out }));
console.log(`回数${K} 分担${SHARD}：${out.length}マス、${((Date.now() - t0) / 1000).toFixed(0)}秒`);
