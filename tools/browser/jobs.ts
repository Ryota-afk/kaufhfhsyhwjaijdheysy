// 照合の盤面と最初の行動を作る（Node の run.ts と同じ作り方）。ブラウザでの照合と Node での照合で共有する。
import { readFileSync } from 'node:fs';
import { loadShowdown, FORMAT } from '../showdown/load.ts';
import { ShowdownRunner } from '../compare/showdown-adapter.ts';
import { genPosition, Rng } from '../compare/gen.ts';
import type { Job } from '../../src/engine/play.ts';
import type { Action } from '../../src/engine/position.ts';

export function makeJobs(npos: number, nseed: number, nturn: number, gseed: number): Job[] {
  const PS = loadShowdown();
  const dex = PS.Dex.forFormat(FORMAT);
  const validator = PS.TeamValidator.get(FORMAT);
  const teams = JSON.parse(readFileSync('data/seed/teams_m7.json', 'utf8')).filter((t: any) => !validator.validateTeam(t.mons.map((m: any) => ({ ...m, name: '', level: 50, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 } }))));
  const rng = new Rng(gseed);
  const jobs: Job[] = [];
  while (jobs.length < npos) {
    const pos = genPosition(rng, teams, dex);
    try {
      const r = new ShowdownRunner(pos, 1);
      const pick = (si: number): Action => { const l = r.legalActions(si); const mv = l.filter(a => a.kind === 'move'); return (mv.length && rng.chance(0.75)) ? rng.pick(mv) : rng.pick(l); };
      const first: [Action, Action] = [pick(0), pick(1)];
      jobs.push({ pos, first, seeds: Array.from({ length: nseed }, (_, k) => 1000 * jobs.length + k + 1), turns: nturn });
    } catch { /* 作り直し */ }
  }
  return jobs;
}
