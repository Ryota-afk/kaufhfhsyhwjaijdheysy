// Showdown の Battle を速く複製する。
// 図鑑のデータ（種族・技・持ち物・特性・状態・ルール）は書き換わらないので共有し、
// それ以外（対戦の状態）は、参照のつながりを保ったまま深く写す。
// Showdown 付属の State.serializeBattle / deserializeBattle と同じ結果になることを照合で確かめる。

const STATIC_CTORS = new Set([
  'Species', 'Item', 'Ability', 'Condition', 'Nature', 'TypeInfo', 'Format', 'RuleTable', 'ModdedDex', 'Learnset',
]);

export function makeCloner(dex: any) {
  const moveCache: Map<string, any> | undefined = dex.moves?.moveCache;
  function isStatic(o: any): boolean {
    const c = o.constructor;
    if (!c) return false;
    const n = c.name;
    if (STATIC_CTORS.has(n) || n.startsWith('Dex')) return true;
    if (n === 'DataMove') {
      // 図鑑の技そのもの（使用中の技の写しではない）なら共有
      const cached = moveCache ? moveCache.get(o.id) : dex.moves.get(o.id);
      return cached === o;
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
      const o = Object.create(Object.getPrototypeOf(v));
      seen.set(v, o);
      const isPokemon = v.constructor?.name === 'Pokemon';
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
