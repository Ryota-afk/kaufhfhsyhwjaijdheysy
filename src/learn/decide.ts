// 探索の設定を変えるかどうかの決め方（指示文 4-5.）：
//   変更前と2000試合以上対戦させ、勝率0.52以上、かつ「勝率 − 誤差の2倍」が0.5を超えたときだけ採用する。
// 試合は「先手後手と構築を入れ替えた2試合」を1組にして打つ。同じ組の2試合は似た結果になりやすいので、
// 誤差は「試合を別々と見た標準誤差」と「組ごとの平均から出した標準誤差」の大きいほうを使う（控えめに見る）。

export interface SearchSettings { c: number; depth: number; dets: number }
export const DEFAULT_SETTINGS: SearchSettings = { c: 0.7, depth: 4, dets: 8 };

export const RULE = { minGames: 2000, minRate: 0.52 };

/** pairs：組ごとの候補側の得点（勝ち1、引き分け0.5、負け0）の2つ。 */
export function judge(pairs: [number, number][]): { games: number; rate: number; se: number; status: '途中' | '採用' | '不採用' } {
  const games = pairs.length * 2;
  if (!pairs.length) return { games: 0, rate: 0, se: 0, status: '途中' };
  const sum = pairs.reduce((a, [x, y]) => a + x + y, 0);
  const rate = sum / games;
  const seGames = Math.sqrt(rate * (1 - rate) / games);
  const means = pairs.map(([x, y]) => (x + y) / 2);
  const varPairs = pairs.length > 1 ? means.reduce((a, m) => a + (m - rate) ** 2, 0) / (pairs.length - 1) : 0.25;
  const sePairs = Math.sqrt(varPairs / pairs.length);
  const se = Math.max(seGames, sePairs);
  if (games < RULE.minGames) return { games, rate, se, status: '途中' };
  return { games, rate, se, status: rate >= RULE.minRate && rate - 2 * se > 0.5 ? '採用' : '不採用' };
}
