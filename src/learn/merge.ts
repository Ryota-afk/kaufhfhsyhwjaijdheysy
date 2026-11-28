// 対戦記録から数えた「相手の型の割合」と「選出の傾向」（data/priors/learned.json）を、最初の確率に混ぜる。
// 記録1件は、上位構築1件分として数える（利用者の決め事、2026-11-27）。
//
// 型（種族ごと）：
//   上位構築に n 回出た種族に、記録で L 回出会い、そのうち「上位構築にない型」の確率の合計が G、
//   上位構築の型 s の確率の合計が P_s だったとき、
//     上位構築の型 s の重み    w_s → w_s + P_s
//     それ以外の型の割合       1/(n+1) → (1 + G) / (n + 1 + L)
//     それ以外の型の中の持ち物・能力ポイントの割合：もとの割合を1件分として、記録の確率を足して割り直す
// 選出（BenchModel）：種族の「選出に入る割合」と、上位構築ごとの3匹の組の割合に、記録の確率を1件分として足す。
import type { PriorEntry } from '../infer/sets.ts';

const toID = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

export interface LearnedSpecies {
  obs: number;                                  // 記録で出会った回数 L
  seed: Record<string, number>;                 // 上位構築の型（seedKey）→ 確率の合計
  generic: number;                              // それ以外の型の確率の合計 G
  items: Record<string, number>;                // 「役割|持ち物」→ それ以外の型での確率の合計
  spreads: Record<string, number>;              // 「役割|性格|能力ポイント」→ 同上
}
export interface Learned {
  updatedAt: string;
  logs: string[];                               // 数えた記録の番号
  sets: Record<string, LearnedSpecies>;         // 種族 id →
  bench: {
    rates: Record<string, [number, number]>;    // 種族 id → [選出に入った確率の合計, 出会った回数]
    teams: Record<string, { n: number; trios: Record<string, number> }>;   // 上位構築の順位 → 記録の数と、3匹の組（構築の並びの番号）→ 確率の合計
  };
}

export const emptyLearned = (): Learned => ({ updatedAt: '', logs: [], sets: {}, bench: { rates: {}, teams: {} } });

/** 上位構築の型の目印（持ち物・特性・性格・能力ポイント・技）。 */
export function seedKey(s: { item: string; ability: string; nature: string; evs: any; moves: string[] }): string {
  const ev = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'].map(k => s.evs?.[k] ?? 0).join('/');
  return [toID(s.item), toID(s.ability), toID(s.nature), ev, [...s.moves].map(toID).sort().join('+')].join('|');
}
export const spreadKey = (role: string, nature: string, evs: any) => `${role}|${toID(nature)}|${['hp', 'atk', 'def', 'spa', 'spd', 'spe'].map(k => evs?.[k] ?? 0).join('/')}`;
export const itemKey = (role: string, item: string) => `${role}|${toID(item)}`;

/** 1種族の最初の確率に、記録で数えたものを混ぜる。 */
export function mergeEntry(e: PriorEntry, l: LearnedSpecies | undefined): PriorEntry {
  if (!l || l.obs <= 0) return e;
  const n = e.seed.reduce((a, s) => a + s.w, 0);
  const seed = e.seed.map(s => ({ ...s, w: s.w + (l.seed[seedKey(s)] ?? 0) }));
  // 上位構築の型がない種族は、全部が「それ以外」のまま
  const otherWeight = e.seed.length ? (1 + l.generic) / (n + 1 + l.obs) : 1;
  const generic = e.generic.map(g => {
    const im = g.items.reduce((a, it) => a + (l.items[itemKey(g.role, it.item)] ?? 0), 0);
    const sm = g.spreads.reduce((a, sp) => a + (l.spreads[spreadKey(g.role, sp.nature, sp.evs)] ?? 0), 0);
    return {
      ...g,
      items: g.items.map(it => ({ ...it, w: (it.w + (l.items[itemKey(g.role, it.item)] ?? 0)) / (1 + im) })),
      spreads: g.spreads.map(sp => ({ ...sp, w: (sp.w + (l.spreads[spreadKey(g.role, sp.nature, sp.evs)] ?? 0)) / (1 + sm) })),
    };
  });
  return { ...e, seed, otherWeight, generic };
}

/** data/priors/sets.json に learned を混ぜた最初の確率。 */
export function mergePriors<T extends { species: Record<string, PriorEntry> }>(priors: T, learned: Learned | null | undefined): T {
  if (!learned) return priors;
  const species: Record<string, PriorEntry> = {};
  for (const [id, e] of Object.entries(priors.species)) species[id] = mergeEntry(e, learned.sets[id]);
  return { ...priors, species };
}
