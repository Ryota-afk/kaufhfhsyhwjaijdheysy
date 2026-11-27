// Showdown を使って、候補ごとの「行動の順番」と「ダメージ（乱数16通り）」を計算し、手がかり（Clue）を作る。
// PS（Showdown 本体）は外から渡す（Node では vendor、ブラウザでは組み立てたファイル）。
import { makeRunner } from '../engine/runner.ts';
import { makeCloner } from '../engine/clone.ts';
import type { Position, MonSet } from '../engine/position.ts';
import type { Clue, SetCand } from './sets.ts';

const toID = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** チャンピオンズで相手に見えるHPの割合（Showdown の getHealth と同じ：切り捨て、残っていれば最低1）。 */
export function shownPercent(hp: number, maxhp: number): number {
  if (hp <= 0) return 0;
  return Math.floor(100 * hp / maxhp) || 1;
}

export function makeCalc(PS: any, FORMAT: string) {
  const Runner = makeRunner(PS, FORMAT);
  const dex = PS.Dex.forFormat(FORMAT);
  const clone = makeCloner(dex, PS.Pokemon);

  /** 盤面 pos の、相手側 oppSide の場の1体を候補 c に置き換えた盤面。 */
  function withCandidate(pos: Position, oppSide: 0 | 1, species: string, c: { item: string; ability: string; nature: string; evs: any; moves: string[] }): Position {
    const p: Position = JSON.parse(JSON.stringify(pos));
    const s = p.sides[oppSide];
    const m = s.mons[s.active];
    const set: MonSet = { species, item: toID(c.item), ability: toID(c.ability), nature: c.nature, evs: c.evs, moves: c.moves.length ? c.moves.map(toID) : ['splash'] };
    // HP は割合で持っている（m.hp を「最大HPに対する%」として受け取り、実数に直す）
    const maxhp = dex.species.get(species).baseStats.hp + c.evs.hp + 75;
    s.mons[s.active] = { ...m, set, hp: Math.min(m.hp, maxhp) };
    return p;
  }

  /**
   * 技を使ったときのダメージを、乱数16通り（85%〜100%）について返す。crit が true なら急所。
   * Showdown の useMoveInner と同じく、タイプ・技の変化（スキン系の特性など）を当ててから getDamage を呼ぶ。
   * 連続技は1発分。失敗・無効なら null。
   */
  function damageRolls(pos: Position, attackerSide: 0 | 1, moveId: string, crit: boolean): number[] | null {
    const b0 = new Runner(pos, 1).battle;
    // ターンの初めの処理（例：ねつこうかんでやけどが治る）を通して、技を出すときの状態にそろえる
    b0.eachEvent('Update');
    const out: number[] = [];
    for (let roll = 0; roll < 16; roll++) {
      // きのみを食べるなどの変化が次の乱数の計算に残らないよう、乱数ごとに盤面を複製する
      const b = clone(b0);
      const src = b.sides[attackerSide].active[0], tgt = b.sides[1 - attackerSide].active[0];
      let move = dex.getActiveMove(toID(moveId));
      b.setActiveMove(move, src, tgt);
      b.singleEvent('ModifyType', move, null, src, tgt, move, move);
      b.singleEvent('ModifyMove', move, null, src, tgt, move, move);
      move = b.runEvent('ModifyType', src, tgt, move, move);
      move = b.runEvent('ModifyMove', src, tgt, move, move);
      // 技を出す前の処理（例：エレクトロビームの「とくこう」アップ）と、当たる直前の処理（例：へんげんじざいのタイプ変化）
      if (!b.singleEvent('TryMove', move, null, src, tgt, move) || !b.runEvent('TryMove', src, tgt, move)) return null;
      if (!b.singleEvent('PrepareHit', move, {}, tgt, src, move) || !b.runEvent('PrepareHit', src, tgt, move)) return null;
      move.willCrit = crit;
      const tr = b.trunc;
      b.randomizer = (d: number) => tr(tr(d * (100 - roll)) / 100);
      const d = b.actions.getDamage(src, tgt, move, true);
      if (typeof d !== 'number') return null;
      out.push(d);
    }
    return out;
  }

  /** 両者が技を選んだときに、相手が先に動く確率（同じ素早さは1/2。せんせいのツメは1/5で先に動く）。 */
  function oppFirstProb(pos: Position, ourSide: 0 | 1, ourMove: string, oppMove: string): number {
    const r = new Runner(pos, 1);
    const b = r.battle;
    const us = b.sides[ourSide].active[0], them = b.sides[1 - ourSide].active[0];
    const act = (pokemon: any, id: string) => {
      const a: any = { choice: 'move', pokemon, move: dex.getActiveMove(toID(id)), targetLoc: 1, order: 200, fractionalPriority: 0 };
      b.getActionSpeed(a);
      return a;
    };
    const a = act(us, ourMove), o = act(them, oppMove);
    let p: number;
    if (o.priority !== a.priority) p = o.priority > a.priority ? 1 : 0;
    else if (o.speed !== a.speed) p = o.speed > a.speed ? 1 : 0;
    else p = 0.5;
    if (them.hasItem('quickclaw') && o.priority === a.priority) p = 0.2 + 0.8 * p;
    if (us.hasItem('quickclaw') && o.priority === a.priority) p = 0.8 * p;
    return p;
  }

  /**
   * 手がかり：素早さの順番。こちらの技 ourMove と相手の技 oppMove で、相手が先に動いた（oppFirst）か。
   * pos はそのターンの初めの盤面（相手の場の1体は候補で置き換える）。
   */
  function clueOrder(pos: Position, ourSide: 0 | 1, species: string, ourMove: string, oppMove: string, oppFirst: boolean): Clue {
    const cache = new Map<string, number>();
    return {
      label: `${oppFirst ? '相手が先' : 'こちらが先'}（${ourMove} と ${oppMove}）`,
      like: (c: SetCand) => {
        const key = JSON.stringify([c.item, c.ability, c.nature, c.evs.spe]);
        let p = cache.get(key);
        if (p === undefined) {
          try { p = oppFirstProb(withCandidate(pos, (1 - ourSide) as 0 | 1, species, { ...c, moves: [oppMove] }), ourSide, ourMove, oppMove); } catch (e: any) { if ((globalThis as any).process?.env?.DEBUG_CALC) console.log("順番の計算の失敗", species, c.item, e.message); p = oppFirst ? 0 : 1; }
          cache.set(key, p);
        }
        return oppFirst ? p : 1 - p;
      },
    };
  }

  /**
   * 手がかり：こちらの技で、相手の見えるHPが before% から after% になった。crit は急所の表示があったか。
   * 相手の本当のHPは分からないので、before% に当たるHPの値を等しくありうるとして数える。
   */
  function clueDamageToOpp(pos: Position, ourSide: 0 | 1, species: string, ourMove: string, before: number, after: number, crit: boolean): Clue {
    const cache = new Map<string, number>();
    const oppSide = (1 - ourSide) as 0 | 1;
    return {
      label: `${ourMove} で相手のHPが ${before}% → ${after}%${crit ? '（急所）' : ''}`,
      like: (c: SetCand) => {
        const key = JSON.stringify([c.item, c.ability, c.nature, c.evs]);
        let p = cache.get(key);
        if (p !== undefined) return p;
        const maxhp = dex.species.get(species).baseStats.hp + c.evs.hp + 75;
        const oppMon = pos.sides[oppSide].mons[pos.sides[oppSide].active];
        const endure = (h: number) => h === maxhp && (toID(c.ability) === 'sturdy' || (toID(c.item) === 'focussash' && !oppMon.itemGone));
        const hs: number[] = [];
        for (let h = 1; h <= maxhp; h++) if (shownPercent(h, maxhp) === before) hs.push(h);
        let hit = 0, total = 0;
        for (const h of hs) {
          const p2 = withCandidate(pos, oppSide, species, c);
          const s = p2.sides[oppSide]; s.mons[s.active].hp = h;
          let rolls: number[] | null;
          try { rolls = damageRolls(p2, ourSide, ourMove, crit); } catch { cache.set(key, 0); return 0; }
          if (!rolls) { total += 16; continue; }
          for (const d0 of rolls) { const d = endure(h) ? Math.min(d0, h - 1) : d0; total++; if (shownPercent(h - d, maxhp) === after) hit++; }
        }
        p = total ? hit / total : 0;
        cache.set(key, p);
        return p;
      },
    };
  }

  /** 手がかり：相手の技で、こちらのHPが before から after（実数）になった。crit は急所の表示があったか。 */
  function clueDamageFromOpp(pos: Position, ourSide: 0 | 1, species: string, oppMove: string, before: number, after: number, crit: boolean): Clue {
    const cache = new Map<string, number>();
    const oppSide = (1 - ourSide) as 0 | 1;
    return {
      label: `相手の ${oppMove} でこちらのHPが ${before} → ${after}${crit ? '（急所）' : ''}`,
      like: (c: SetCand) => {
        const key = JSON.stringify([c.item, c.ability, c.nature, c.evs]);
        let p = cache.get(key);
        if (p !== undefined) return p;
        const p2 = withCandidate(pos, oppSide, species, { ...c, moves: [oppMove] });
        const s = p2.sides[ourSide]; s.mons[s.active].hp = before;
        let rolls: number[] | null;
        try { rolls = damageRolls(p2, oppSide, oppMove, crit); } catch { rolls = null; }
        const ours = p2.sides[ourSide].mons[p2.sides[ourSide].active];
        const ourMax = dex.species.get(ours.set.species).baseStats.hp + ours.set.evs.hp + 75;
        const endure = before === ourMax && (ours.set.ability === 'sturdy' || (ours.set.item === 'focussash' && !ours.itemGone));
        p = rolls ? rolls.filter(d => Math.max(0, before - (endure ? Math.min(d, before - 1) : d)) === after).length / 16 : 0;
        cache.set(key, p);
        return p;
      },
    };
  }

  return { damageRolls, oppFirstProb, clueOrder, clueDamageToOpp, clueDamageFromOpp, withCandidate };
}
