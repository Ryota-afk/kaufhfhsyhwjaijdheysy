// パーティの中身（6匹の型）の目印。先回りの計算の表が、今のパーティで作ったものかを確かめるのに使う。
// 名前や「よく使う」の印を変えただけでは変わらない。ブラウザと Node の両方で同じ値になるよう、簡単な hash（FNV-1a を2本）にする。
export const plainSet = (m: any) => ({ species: m.species, item: m.item, ability: m.ability, nature: m.nature, evs: m.evs, moves: m.moves });
export function partyKey(mons: any[]): string {
  const s = JSON.stringify(mons.map(plainSet));
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x01000193 ^ 0x2f) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}
