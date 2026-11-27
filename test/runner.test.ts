import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ShowdownRunner } from '../tools/compare/showdown-adapter.ts';
import { genPosition, Rng } from '../tools/compare/gen.ts';
import { loadShowdown, FORMAT } from '../tools/showdown/load.ts';

test('盤面の形に戻す：盤面から作った対戦を戻すと、もとの盤面と同じ結果になる（200盤面）', () => {
  const PS = loadShowdown(); const dex = PS.Dex.forFormat(FORMAT);
  const teams = JSON.parse(readFileSync('data/seed/teams_m7.json', 'utf8')).filter((t: any) => t.mons.every((m: any) => m.ability) && t.rank !== 59);
  const rng = new Rng(3);
  let n = 0;
  for (let k = 0; k < 200; k++) {
    const pos = genPosition(rng, teams, dex);
    let r; try { r = new ShowdownRunner(pos, 1); } catch { continue; }
    const back = r.toPosition();
    // 戻した盤面から作り直しても、同じ種で打った結果が同じになる
    const a = new ShowdownRunner(pos, 7), b = new ShowdownRunner(back, 7);
    const la = a.legalActions(0), lb = b.legalActions(0);
    assert.deepEqual(lb, la);
    const act0 = la[0], act1 = a.legalActions(1)[0];
    a.play(act0, act1); b.play(act0, act1);
    assert.deepEqual(b.outcome(), a.outcome(), `盤面${k}`);
    n++;
  }
  assert.ok(n > 150);
});
