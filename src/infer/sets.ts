// 相手の1体の型の候補と、見えた情報での更新（ベイズの式）。画面にも Node にも依存しない。
// 名前はすべて Showdown の英語名で持つ。
export type Stats = Record<'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe', number>;
export interface SetCand {
  prior: number;          // 最初の確率（合計1）
  generic: boolean;       // 上位構築にない「それ以外」の型か
  role?: string;
  item: string; ability: string; nature: string; evs: Stats;
  moves: string[];        // 決まっている技（上位構築の型は4つ。generic は空）
  pool?: string[];        // generic の技の候補（ここから4つ）
}
export interface PriorEntry {
  name: string; seedCount: number; otherWeight: number;
  seed: { w: number; item: string; ability: string; nature: string; evs: Stats; moves: string[] }[];
  generic: { role: string; pool: string[]; abilities: string[]; items: { item: string; w: number }[]; spreads: { nature: string; evs: Stats; w: number }[] }[];
}

const toID = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** 最初の候補を展開する。上位構築の型に (1-otherWeight)、それ以外の型に otherWeight を配る。 */
export function expandPrior(e: PriorEntry): SetCand[] {
  const out: SetCand[] = [];
  const seedTotal = e.seed.reduce((a, s) => a + s.w, 0);
  const seedMass = e.seed.length ? 1 - e.otherWeight : 0;
  for (const s of e.seed) out.push({ prior: seedMass * s.w / seedTotal, generic: false, item: s.item, ability: s.ability, nature: s.nature, evs: s.evs, moves: s.moves });
  const genMass = 1 - seedMass;
  for (const g of e.generic) {
    const roleMass = genMass / e.generic.length;
    for (const ab of g.abilities) for (const it of g.items) for (const sp of g.spreads) {
      out.push({ prior: roleMass / g.abilities.length * it.w * sp.w, generic: true, role: g.role, item: it.item, ability: ab, nature: sp.nature, evs: sp.evs, moves: [], pool: g.pool });
    }
  }
  const total = out.reduce((a, c) => a + c.prior, 0);
  for (const c of out) c.prior /= total;
  return out;
}

function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = r * (n - k + i) / i;
  return r;
}

/** 見えた技の集まり R が出る確率（候補ごと）。上位構築の型：全部持っていれば1。generic：候補から4つ選んで R を全部含む確率。 */
export function movesLikelihood(c: SetCand, revealed: string[]): number {
  const R = [...new Set(revealed.map(toID))];
  if (!c.generic) { const have = new Set(c.moves.map(toID)); return R.every(m => have.has(m)) ? 1 : 0; }
  const pool = new Set((c.pool ?? []).map(toID));
  if (!R.every(m => pool.has(m))) return 0;
  const n = pool.size, k = Math.min(4, n);
  return choose(n - R.length, k - R.length) / choose(n, k);
}

/** 見えた情報。like は候補ごとの「その情報が見える確率」（0〜1）。 */
export interface Clue { label: string; like: (c: SetCand) => number }

export const clueItem = (item: string): Clue => ({ label: `持ち物が ${item}`, like: c => toID(c.item) === toID(item) ? 1 : 0 });
export const clueNotItem = (item: string): Clue => ({ label: `持ち物が ${item} ではない`, like: c => toID(c.item) === toID(item) ? 0 : 1 });
export const clueAbility = (ability: string): Clue => ({ label: `特性が ${ability}`, like: c => toID(c.ability) === toID(ability) ? 1 : 0 });

/** 1体の推定。見えた技と、それ以外の手がかりを持ち、確率を出す。 */
export class OpponentSet {
  cands: SetCand[];
  moves: string[] = [];
  clues: Clue[] = [];
  private cache: number[] | null = null;
  constructor(cands: SetCand[]) { this.cands = cands; }
  revealMove(m: string) { if (!this.moves.some(x => toID(x) === toID(m))) { this.moves.push(m); this.cache = null; } }
  add(clue: Clue) { this.clues.push(clue); this.cache = null; }
  /** 候補ごとの今の確率（合計1）。どの候補とも合わないときは null。 */
  posterior(): number[] | null {
    if (this.cache) return this.cache;
    const w = this.cands.map(c => {
      let p = c.prior * movesLikelihood(c, this.moves);
      for (const cl of this.clues) { if (!p) break; p *= cl.like(c); }
      return p;
    });
    const total = w.reduce((a, b) => a + b, 0);
    if (!(total > 0)) return null;
    this.cache = w.map(x => x / total);
    return this.cache;
  }
  /** 項目ごとの確率（持ち物、特性、性格など）。key で値を取り出す。 */
  marginal(key: (c: SetCand) => string): Map<string, number> {
    const post = this.posterior(); const m = new Map<string, number>();
    if (!post) return m;
    this.cands.forEach((c, i) => { if (post[i]) { const k = key(c); m.set(k, (m.get(k) ?? 0) + post[i]); } });
    return new Map([...m.entries()].sort((a, b) => b[1] - a[1]));
  }
  /** まだ見えていない技を含め、各技を持っている確率。 */
  moveProbabilities(): Map<string, number> {
    const post = this.posterior(); const m = new Map<string, number>();
    if (!post) return m;
    const R = new Set(this.moves.map(toID));
    this.cands.forEach((c, i) => {
      const p = post[i]; if (!p) return;
      if (!c.generic) { for (const mv of c.moves) m.set(mv, (m.get(mv) ?? 0) + p); return; }
      // generic：見えた技は確定。残りの枠は、候補の残りから等しく選ぶ
      const pool = c.pool ?? []; const rest = pool.filter(x => !R.has(toID(x)));
      const slots = Math.min(4, pool.length) - R.size;
      for (const mv of pool) m.set(mv, (m.get(mv) ?? 0) + p * (R.has(toID(mv)) ? 1 : rest.length ? slots / rest.length : 0));
    });
    return new Map([...m.entries()].sort((a, b) => b[1] - a[1]));
  }
  /** 探索で使うために、今の確率に従って型を1つ抜き出す（generic は残りの技も抜き出して4つにする）。 */
  sample(rand: () => number): { item: string; ability: string; nature: string; evs: Stats; moves: string[] } | null {
    const post = this.posterior(); if (!post) return null;
    let r = rand(), i = 0;
    for (; i < post.length - 1; i++) { r -= post[i]; if (r <= 0) break; }
    const c = this.cands[i];
    let moves = c.moves;
    if (c.generic) {
      const R = new Set(this.moves.map(toID));
      const rest = (c.pool ?? []).filter(x => !R.has(toID(x)));
      const pick = [...this.moves];
      while (pick.length < 4 && rest.length) pick.push(rest.splice(Math.floor(rand() * rest.length), 1)[0]);
      moves = pick;
    }
    return { item: c.item, ability: c.ability, nature: c.nature, evs: c.evs, moves };
  }
}
