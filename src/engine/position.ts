// 盤面の共通の書き方。照合（Showdown と専用エンジン）と、のちの探索で使う。
// 名前はすべて Showdown の id（小文字英数字）で持つ。

export type StatID = 'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe';
export type BoostID = 'atk' | 'def' | 'spa' | 'spd' | 'spe' | 'accuracy' | 'evasion';
export type StatusID = '' | 'brn' | 'par' | 'psn' | 'tox' | 'slp' | 'frz';

export interface MonSet {
  species: string; item: string; ability: string; nature: string;
  evs: Record<StatID, number>; moves: string[];
}

/** 盤面の1体。 */
export interface PosMon {
  set: MonSet;
  hp: number;                 // 今のHP（実数）
  status: StatusID;
  statusTime?: number;        // ねむり・こおり：残りの数え（Showdown の statusState.time）。もうどく：段階（stage）
  boosts?: Partial<Record<BoostID, number>>;
  itemGone?: boolean;         // 持ち物を失っている
  mega?: boolean;             // すでにメガシンカしている
  forme?: string;             // メガシンカ以外で姿が変わっている（例：Mimikyu-Busted、Aegislash-Blade）
  pp?: number[];              // 技ごとの残りPP（省略時は最大）
  vol?: PosVolatiles;         // 場に出ているときだけ意味がある
}

export interface PosVolatiles {
  substitute?: number;        // みがわりの残りHP
  confusion?: number;         // こんらんの残りの数え
  leechseed?: boolean;
  taunt?: number;             // ちょうはつの残りターン
  choicelock?: string;        // こだわりで固定された技
  yawn?: number;              // あくびの残り
  focusenergy?: boolean;
  curse?: boolean;
}

export interface PosSide {
  mons: PosMon[];             // 選出した3体（並びは固定。番号で呼ぶ）
  active: number;             // 場に出ている番号
  megaUsed?: boolean;
  cond?: {
    stealthrock?: boolean; spikes?: number; toxicspikes?: number; stickyweb?: boolean;
    reflect?: number; lightscreen?: number; auroraveil?: number; tailwind?: number;  // 残りターン
  };
}

export interface Position {
  sides: [PosSide, PosSide];
  field?: {
    weather?: { id: string; turns: number };   // id: raindance / sunnyday / sandstorm / snowscape
    terrain?: { id: string; turns: number };   // id: electricterrain / grassyterrain / mistyterrain / psychicterrain
    trickroom?: number;
  };
  turn?: number;
}

/** 1ターンの行動。move の slot は 0〜3、switch の to は mons の番号。 */
export type Action = { kind: 'move'; slot: number; mega?: boolean } | { kind: 'switch'; to: number };

/** 1ターン（と、その途中の交代）を終えた後の結果。両方の実装でこの形にそろえて比べる。 */
export interface Outcome {
  ended: boolean;
  winner: 0 | 1 | null;
  sides: OutcomeSide[];
  field: { weather: string; weatherTurns: number; terrain: string; terrainTurns: number; trickroom: number };
}
export interface OutcomeSide {
  active: number;
  cond: Record<string, number>;      // 場の状態：層の数か残りターン
  mons: OutcomeMon[];
}
export interface OutcomeMon {
  hp: number; status: string; boosts: string; item: string; species: string; vols: string;
}

/** 比べる対象にする場の状態・一時的な状態（両方の実装で同じ名前にする）。 */
export const TRACKED_VOLATILES = [
  'substitute', 'confusion', 'leechseed', 'taunt', 'encore', 'disable', 'choicelock', 'lockedmove',
  'partiallytrapped', 'yawn', 'focusenergy', 'curse', 'perishsong', 'destinybond', 'smackdown', 'stall',
  'charge', 'throatchop', 'glaiverush', 'flashfire', 'mustrecharge', 'twoturnmove', 'protosynthesis',
] as const;
export const TRACKED_SIDE = ['stealthrock', 'spikes', 'toxicspikes', 'stickyweb', 'reflect', 'lightscreen', 'auroraveil', 'tailwind', 'wish', 'healingwish'] as const;

export function toID(s: string): string { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
