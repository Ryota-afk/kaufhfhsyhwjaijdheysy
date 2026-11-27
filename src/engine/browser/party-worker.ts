// パーティの入力画面用の Worker：覚えられる技の表とチームの検査を含む Showdown を読み込み、画面に必要な情報を返す。
import { PS } from '@showdown-full';

const FORMAT = 'gen9championsbssregmc';
const dex = PS.Dex.forFormat(FORMAT);
const validator = PS.TeamValidator.get(FORMAT);
const legal = (x: any) => x.exists && !x.isNonstandard;

self.onmessage = (ev: MessageEvent) => {
  const msg = ev.data;
  try {
    if (msg.type === 'init') {
      // 選べるポケモン：チャンピオンズで使え、メガシンカや戦闘中だけの姿ではないもの
      const species = dex.species.all().filter((s: any) => legal(s) && !s.battleOnly && !s.isMega && s.tier !== 'Illegal').map((s: any) => ({
        id: s.id, name: s.name, baseStats: s.baseStats, abilities: [...new Set(Object.values(s.abilities))], types: s.types,
        movepool: [...dex.species.getMovePool(s.id)],
      }));
      const moves = dex.moves.all().filter(legal).map((m: any) => ({ id: m.id, name: m.name }));
      const items = dex.items.all().filter(legal).map((i: any) => ({ id: i.id, name: i.name }));
      const abilities = dex.abilities.all().filter(legal).map((a: any) => ({ id: a.id, name: a.name }));
      const natures = dex.natures.all().map((n: any) => ({ id: n.id, name: n.name, plus: n.plus ?? '', minus: n.minus ?? '' }));
      (self as any).postMessage({ type: 'init', species, moves, items, abilities, natures });
    } else if (msg.type === 'validate') {
      const sets = msg.mons.map((m: any) => ({ name: '', species: m.species, item: m.item, ability: m.ability, nature: m.nature, evs: m.evs, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }, moves: m.moves.filter(Boolean), level: 50, gender: m.gender ?? '' }));
      (self as any).postMessage({ type: 'validate', problems: validator.validateTeam(sets) ?? [] });
    }
  } catch (e: any) {
    (self as any).postMessage({ type: 'error', message: String(e?.stack ?? e) });
  }
};
