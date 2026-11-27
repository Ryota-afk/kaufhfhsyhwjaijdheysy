// Showdown の Battle を速く複製する。
// 図鑑のデータ（種族・技・持ち物・特性・状態・ルール）は Showdown 側で書き換え禁止（凍結）なので共有し、
// それ以外（対戦の状態）は、参照のつながりを保ったまま深く写す。
// 図鑑のデータかどうかは、クラスの名前ではなく実物のクラス（prototype）で見分ける。
// サイトの組み立てでプログラムが縮められると、クラスの名前が変わるため。

export function makeCloner(dex: any, PokemonClass: any) {
  // 図鑑のデータのクラス（実物から取り出す）
  const staticProtos = new Set<object>();
  const add = (o: any) => { if (o && typeof o === 'object') staticProtos.add(Object.getPrototypeOf(o)); };
  add(dex);                                   // ModdedDex
  add(dex.species.get('pikachu'));            // Species
  add(dex.items.get('leftovers'));            // Item
  add(dex.abilities.get('intimidate'));       // Ability
  add(dex.conditions.get('brn'));             // Condition
  add(dex.natures.get('adamant'));            // Nature
  add(dex.types.get('Fire'));                 // TypeInfo
  const format = dex.formats.get('gen9championsbssregmc');
  add(format);                                // Format
  add(dex.formats.getRuleTable(format));      // RuleTable
  for (const k of Object.keys(dex)) {         // DexSpecies、DexMoves などの入れ物
    const v = dex[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && v.dex === dex) add(v);
  }
  const dataMoveProto = Object.getPrototypeOf(dex.moves.get('earthquake'));
  const pokemonProto = PokemonClass.prototype;
  staticProtos.delete(Object.prototype);

  function isStatic(o: any): boolean {
    const proto = Object.getPrototypeOf(o);
    if (staticProtos.has(proto)) return true;
    if (proto === dataMoveProto) {
      // 図鑑の技そのもの（使用中の技の写しではない）なら共有
      return dex.moves.get(o.id) === o;
    }
    return false;
  }

  // Pokemon は自分を指す矢印関数（getHealth、getFullDetails）を持つので、複製先に付け直す。
  const rebind = new Map<string, (self: any) => any>();
  function rebinder(key: string, fn: Function): (self: any) => any {
    let r = rebind.get(key);
    if (!r) {
      const src = fn.toString();
      const m = /^\s*\(\s*\)\s*=>\s*\{([\s\S]*)\}\s*$/.exec(src);
      if (!m) throw new Error(`付け直せない関数：${key}`);
      // eslint-disable-next-line no-new-func
      const body = new Function(m[1]);
      r = (self: any) => body.bind(self);
      rebind.set(key, r);
    }
    return r;
  }
  const arrowCache = new WeakMap<Function, boolean>();
  function isArrow(fn: Function): boolean {
    let r = arrowCache.get(fn);
    if (r === undefined) { r = /^\s*\([^)]*\)\s*=>/.test(fn.toString()); arrowCache.set(fn, r); }
    return r;
  }

  return function cloneBattle<T>(battle: T): T {
    const seen = new Map<any, any>();
    const copy = (v: any): any => {
      if (v === null || typeof v !== 'object') return v;
      const prev = seen.get(v);
      if (prev !== undefined) return prev;
      if (isStatic(v)) { seen.set(v, v); return v; }
      if (ArrayBuffer.isView(v)) {
        const t = (v as any).slice();
        seen.set(v, t);
        return t;
      }
      if (Array.isArray(v)) {
        const a: any[] = new Array(v.length);
        seen.set(v, a);
        for (let i = 0; i < v.length; i++) a[i] = copy(v[i]);
        return a;
      }
      if (v instanceof Map) {
        const m = new Map();
        seen.set(v, m);
        for (const [k, x] of v) m.set(copy(k), copy(x));
        return m;
      }
      if (v instanceof Set) {
        const s = new Set();
        seen.set(v, s);
        for (const x of v) s.add(copy(x));
        return s;
      }
      const proto = Object.getPrototypeOf(v);
      const o = Object.create(proto);
      seen.set(v, o);
      const isPokemon = proto === pokemonProto;
      for (const k of Object.keys(v)) {
        const x = v[k];
        if (isPokemon && typeof x === 'function' && isArrow(x)) o[k] = rebinder(k, x)(o);
        else o[k] = copy(x);
      }
      return o;
    };
    return copy(battle);
  };
}
