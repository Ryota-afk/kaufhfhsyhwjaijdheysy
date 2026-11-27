// AIどうしの1試合（設定の比べ用）。両者とも、自分の画面に見えることだけを記録係に入れて相手の型を推定し、
// 仮の盤面を settings.dets 個作って、1手ごとに iters 回だけ探索して手を選ぶ（サイトの対戦中の判断と同じ流れ）。
// 倒れた後の交代先は、Showdown の盤面の並びの若い番号（両者同じ）。
import { search } from '../search/mcts.ts';
import { sideTurnInput, revealFoe, type SideView } from './viewer.ts';
import type { SearchSettings } from './decide.ts';
import type { Action, Position, StatusID } from '../engine/position.ts';

// dex・Runner・Analyzer は記録を作る Showdown、FastRunner・clone は速さの層を当てた別の写しの Showdown（探索用）
export interface DuelEnv { dex: any; Runner: any; FastRunner: any; clone: (b: any) => any; Analyzer: any }
export interface DuelSpec {
  teams: [any, any];                 // 両者の構築（teams_m7.json の1件）
  idx: [number[], number[]];         // 両者の選出（構築の番号3つ、先頭が先発）
  settings: [SearchSettings, SearchSettings];
  iters: number;
  seed: number;
}
export interface DuelResult { winner: 0 | 1 | null; turns: number; errors: string[]; ms: number }

const toID = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const setOf = (m: any) => ({ species: m.species, item: toID(m.item), ability: toID(m.ability), nature: m.nature, evs: m.evs, moves: m.moves.map(toID) });

export function playDuel(env: DuelEnv, d: DuelSpec): DuelResult {
  const t0 = Date.now();
  const { dex, Runner, FastRunner, clone, Analyzer } = env;
  let st = (d.seed >>> 0) || 1;
  const rand = () => { st = (st * 1664525 + 1013904223) >>> 0; return st / 4294967296; };
  const sets = [0, 1].map(s => d.idx[s].map(i => setOf(d.teams[s].mons[i])));
  const pos: Position = { sides: [0, 1].map(s => ({ mons: sets[s].map(x => ({ set: x, hp: 999, status: '' as StatusID })), active: 0 })) as any };
  const truth = new Runner(pos, d.seed, true);
  const b = truth.battle;
  const errors: string[] = [];
  const views: SideView[] = [0, 1].map(s => ({ side: s as 0 | 1, mySets: sets[s], foeSpecies: d.teams[1 - s].mons.map((m: any) => dex.species.get(m.species).name), foeIdx: d.idx[1 - s] }));
  const ans = [0, 1].map(s => new Analyzer({ ours: sets[s], ourLead: 0, oppSpecies: views[s].foeSpecies, ourTeamJa: d.teams[s].mons.map((m: any) => m.jp) }));
  [0, 1].forEach(s => { const r = revealFoe(dex, b.log, s as 0 | 1, sets[1 - s][0].species); ans[s].start({ oppLead: d.idx[1 - s][0], oppAbility: r.ability, oppItem: r.item }); });

  /** 側 s の手：推定から仮の盤面を作って探索し、いちばん回数の多い手。うまくいかなければ、選べる手から無作為に。 */
  const choose = (s: number): Action | null => {
    const legal: Action[] = truth.legalActions(s);
    if (!legal.length) return null;
    try {
      const dets: Position[] = ans[s].determinizations(d.settings[s].dets, rand);
      // 記録係の盤面は「こちらが p1」。p2 の側でも、そのまま p1 として探索する
      const roots = dets.map((p, k) => new FastRunner(p, (d.seed + k * 7919) >>> 0).battle);
      const r = search(roots, clone, { timeMs: 1e9, maxIters: d.iters, c: d.settings[s].c, depth: d.settings[s].depth, rand });
      // 回数の多い順に見て、本当に選べる手のうち最初のもの（記録係が追っていない状態、例：アンコール・かなしばりで選べない手がある）
      const same = (x: any, y: any) => x.kind === y.kind && (x.kind === 'switch' ? x.to === y.to : x.slot === y.slot && !!x.mega === !!y.mega);
      const ranked = [...r.ours].filter(x => x.n > 0).sort((x, y) => y.n - x.n);
      if (!ranked.length) throw new Error('探索が手を返さなかった');
      for (const [k, x] of ranked.entries()) {
        const want = ans[s].describe(x.choice);
        const hit = legal.find(y => same(y, want));
        if (hit) { if (k > 0) errors.push(`側${s + 1}：いちばんの手は選べず、${k + 1}番目の手を打った（探索の上位 ${ranked.slice(0, k).map(x => x.choice).join('、')}、選べる手 ${legal.map(x => JSON.stringify(x)).join('')}、本当の場 ${b.sides[s].active[0].species.name}、記録係の場 ${ans[s].pos.sides[0].mons[ans[s].pos.sides[0].active].set.species}）`); return hit; }
      }
      throw new Error('探索のどの手も選べない');
    } catch (e: any) {
      errors.push(`側${s + 1}：${e.message}`);
      return legal[Math.floor(rand() * legal.length)];
    }
  };

  let turns = 0;
  for (let t = 0; t < 60 && !b.ended; t++) {
    const foeBefore = [b.sides[1].active[0], b.sides[0].active[0]];
    const from = b.log.length, turnBefore = b.turn;
    let a: (Action | null)[] = [choose(0), choose(1)];
    truth.play(a[0], a[1]);
    // Showdown が受け付けずにターンが進まなかったら、選べる手から無作為に打ち直す
    for (let tries = 0; tries < 8 && b.turn === turnBefore && !b.ended; tries++) {
      errors.push('ターンが進まなかった');
      const l = [truth.legalActions(0), truth.legalActions(1)];
      a = l.map(x => x.length ? x[Math.floor(rand() * x.length)] : null);
      for (const sd of b.sides) if (sd.activeRequest && !sd.activeRequest.wait) sd.choice = { cantUndo: false, error: '', actions: [], forcedSwitchesLeft: 0, forcedPassesLeft: 0, switchIns: new Set(), zMove: false, mega: false, ultra: false, dynamax: false, terastallize: false };
      truth.play(a[0], a[1]);
    }
    if (b.turn === turnBefore && !b.ended) break;
    turns++;
    if (b.ended) break;
    const lines = (b.log as string[]).slice(from);
    for (const s of [0, 1]) {
      try { ans[s].record(sideTurnInput(dex, b, views[s], lines, a[s], a[1 - s], foeBefore[s])); }
      catch (e: any) { errors.push(`側${s + 1} 記録係：${e.message}`); }
    }
  }
  const winner = !b.ended || !b.winner ? null : b.winner === b.sides[0].name ? 0 : 1;
  return { winner, turns, errors, ms: Date.now() - t0 };
}
