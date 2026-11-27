// パーティのデータの形、実数値の計算、検査（日本語のメッセージ）。画面にも Node にも依存しない。
export type StatID = 'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe';
export const STATS: StatID[] = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
export const STAT_JA: Record<StatID, string> = { hp: 'HP', atk: 'こうげき', def: 'ぼうぎょ', spa: 'とくこう', spd: 'とくぼう', spe: 'すばやさ' };
export const SP_MAX = 32;     // 能力ポイントの1つあたりの上限
export const SP_TOTAL = 66;   // 能力ポイントの合計の上限

/** 1体。名前は Showdown の英語名（data/seed と同じ形）。 */
export interface PartyMon {
  species: string; item: string; ability: string; nature: string;
  evs: Record<StatID, number>; moves: string[]; gender?: 'M' | 'F' | '';
}
// precompute：「よく使う」の印。印のあるパーティだけ、裏の計算（GitHub Actions）で選出の表を先に解く
export interface Party { id: string; name: string; updatedAt: string; precompute?: boolean; mons: PartyMon[] }

export function emptyMon(): PartyMon {
  return { species: '', item: '', ability: '', nature: 'Hardy', evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }, moves: ['', '', '', ''], gender: '' };
}
export function newParty(name = '新しいパーティ'): Party {
  const id = 'p' + new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14) + Math.floor(Math.random() * 1e4).toString().padStart(4, '0');
  return { id, name, updatedAt: new Date().toISOString(), mons: Array.from({ length: 6 }, emptyMon) };
}

/**
 * 実数値（レベル50、チャンピオンズ）。Showdown の champions の statModify と同じ式：
 * HP = 種族値 + 能力ポイント + 75、ほか = 種族値 + 能力ポイント + 20 に性格補正（1.1倍・0.9倍の切り捨て）。
 */
export function calcStat(stat: StatID, base: number, sp: number, plus?: string, minus?: string): number {
  if (stat === 'hp') return base + sp + 75;
  let v = base + sp + 20;
  if (plus === stat) v = Math.floor(((v * 110) % 65536) / 100);
  else if (minus === stat) v = Math.floor(((v * 90) % 65536) / 100);
  return v;
}

export interface MonInfo { baseStats: Record<StatID, number>; abilities: string[]; movepool: Set<string> }
export interface Problem { slot: number | null; text: string }

/** 入力の検査（日本語）。species などの名前は英語名。info は種族ごとの情報（Showdown から作る）。 */
export function checkParty(mons: PartyMon[], info: (species: string) => MonInfo | undefined, ja: (kind: string, name: string) => string, toID: (s: string) => string): Problem[] {
  const out: Problem[] = [];
  const filled = mons.filter(m => m.species);
  if (filled.length !== 6) out.push({ slot: null, text: `ポケモンが ${filled.length} 体です。6体入れてください。` });
  const seenSpecies = new Map<string, number>(), seenItem = new Map<string, number>();
  mons.forEach((m, i) => {
    if (!m.species) return;
    const inf = info(m.species);
    if (!inf) { out.push({ slot: i, text: `「${m.species}」はチャンピオンズで使えないか、名前が分かりません。` }); return; }
    const base = toID(m.species);
    if (seenSpecies.has(base)) out.push({ slot: i, text: `${ja('species', m.species)} が2体います（同じポケモンは1体まで）。` });
    seenSpecies.set(base, i);
    if (m.item) {
      const it = toID(m.item);
      if (seenItem.has(it)) out.push({ slot: i, text: `持ち物 ${ja('items', m.item)} が2つあります（同じ持ち物は1つまで）。` });
      seenItem.set(it, i);
    } else out.push({ slot: i, text: '持ち物が入っていません。' });
    if (!m.ability) out.push({ slot: i, text: '特性が入っていません。' });
    else if (!inf.abilities.map(toID).includes(toID(m.ability))) out.push({ slot: i, text: `特性 ${ja('abilities', m.ability)} は、このポケモンの特性ではありません。` });
    const moves = m.moves.filter(Boolean);
    if (!moves.length) out.push({ slot: i, text: '技が1つも入っていません。' });
    const seenMove = new Set<string>();
    for (const mv of moves) {
      const id = toID(mv);
      if (seenMove.has(id)) out.push({ slot: i, text: `技 ${ja('moves', mv)} が2つあります。` });
      seenMove.add(id);
      if (!inf.movepool.has(id)) out.push({ slot: i, text: `${ja('species', m.species)} は ${ja('moves', mv)} を覚えません。` });
    }
    let sum = 0;
    for (const s of STATS) {
      const v = m.evs[s];
      if (!Number.isInteger(v) || v < 0 || v > SP_MAX) out.push({ slot: i, text: `${STAT_JA[s]} の能力ポイントは 0〜${SP_MAX} の整数にしてください（今 ${v}）。` });
      sum += v || 0;
    }
    if (sum > SP_TOTAL) out.push({ slot: i, text: `能力ポイントの合計が ${sum} です（${SP_TOTAL} まで）。` });
  });
  return out;
}
