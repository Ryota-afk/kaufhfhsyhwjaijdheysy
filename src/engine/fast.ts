// Showdown を探索向けに速くする層。対戦の処理（乱数の使い方を含む）は変えない。
// 1. 記録（ログ）の文字列を作らない。
// 2. イベントの処理先を探すとき、そのイベントの処理を持つ効果の一覧を先に作っておき、持たない効果は調べない。
// 照合（tools/compare）で、この層を当てた結果が、当てない Showdown と乱数の種ごとに完全に一致することを確かめる。

export interface SpeedLayerOptions { noLog?: boolean; events?: boolean; activeMove?: boolean }

export function applySpeedLayer(PS: any, Battle: any, formatId: string, opt: SpeedLayerOptions = { noLog: true, events: true, activeMove: true }) {
  const P = Battle.prototype;
  if (P.__speedLayer) return;
  P.__speedLayer = true;

  // 1. 記録を作らない
  if (opt.noLog) {
  P.add = function () {};
  P.addMove = function () {};
  P.attrLastMove = function () {};
  P.retargetLastMove = function () {};
  P.hint = function () {};
  P.addSplit = function () {};
  P.debug = function () {};
  P.sendUpdates = function () {};
  }

  const dex = PS.Dex.forFormat(formatId);

  // 3. 使用中の技の写し（getActiveMove）：Showdown は図鑑の技を丸ごと深く写す。
  //    技の中の効果の定義（condition）は対戦中に書き換えられないので、写さずに共有する。それ以外は同じく深く写す。
  const deepClone = PS.Utils.deepClone;
  const ModdedDex = Object.getPrototypeOf(dex).constructor;
  const objKeysOf = new WeakMap<object, string[]>();
  if (opt.activeMove) ModdedDex.prototype.getActiveMove = function (move: any) {
    if (move && typeof move.hit === 'number') return move;
    move = this.moves.get(move);
    let objKeys = objKeysOf.get(move);
    if (!objKeys) {
      objKeys = Object.keys(move).filter(k => k !== 'condition' && move[k] !== null && typeof move[k] === 'object');
      objKeysOf.set(move, objKeys);
    }
    const c = Object.assign(Object.create(Object.getPrototypeOf(move)), move);
    for (let i = 0; i < objKeys.length; i++) c[objKeys[i]] = deepClone(move[objKeys[i]]);
    c.hit = 0;
    return c;
  };

  if (!opt.events) return;
  // 2. 処理先の一覧
  type Kinds = { status: Set<string>; volatile: Set<string>; ability: Set<string>; item: Set<string>; species: Set<string>; side: Set<string>; field: Set<string> };
  const INDEX = new Map<string, Kinds>();
  const kinds = (cb: string) => {
    let k = INDEX.get(cb);
    if (!k) { k = { status: new Set(), volatile: new Set(), ability: new Set(), item: new Set(), species: new Set(), side: new Set(), field: new Set() }; INDEX.set(cb, k); }
    return k;
  };
  const addAll = (obj: any, id: string, kind: keyof Kinds) => {
    if (!obj) return;
    // 処理は関数とは限らない（例：シェルアーマーは onCriticalHit: false）。値があれば一覧に入れる
    for (const key in obj) if (key.startsWith('on') && obj[key] !== undefined) kinds(key)[kind].add(id);
    if (kind === 'ability' || kind === 'item') {
      // Showdown は場に出たとき onSwitchIn の代わりに onStart を呼ぶ（getCallback の特別扱い）
      if (obj.onSwitchIn === undefined && !obj.onAnySwitchIn && obj.onStart !== undefined) kinds('onSwitchIn')[kind].add(id);
    }
  };
  // 状態・一時的な状態・場の状態・天気・フィールドは、すべて conditions で引ける
  const condIds = new Set<string>([...Object.keys(dex.data.Conditions)]);
  for (const m of dex.moves.all()) if (m.condition) condIds.add(m.id);
  for (const it of dex.items.all()) if (it.condition) condIds.add(it.id);
  for (const a of dex.abilities.all()) if (a.condition) condIds.add(a.id);
  for (const id of condIds) {
    const c = dex.conditions.getByID(id);
    if (!c?.exists) continue;
    for (const kind of ['status', 'volatile', 'side', 'field'] as const) addAll(c, id, kind);
  }
  for (const a of dex.abilities.all()) addAll(a, a.id, 'ability');
  for (const it of dex.items.all()) addAll(it, it.id, 'item');
  for (const s of dex.species.all()) addAll(s, s.id, 'species');
  // 空の特性・持ち物（id ''）も Showdown では効果として扱われるので、同じく登録
  addAll(dex.abilities.getByID(''), '', 'ability');
  addAll(dex.items.getByID(''), '', 'item');

  const origPokemon = P.findPokemonEventHandlers;
  const origSide = P.findSideEventHandlers;
  const origField = P.findFieldEventHandlers;
  const origBattle = P.findBattleEventHandlers;

  // その効果の持ち主が、この処理名の処理を1つでも持つか
  function pokemonHas(pokemon: any, k: Kinds): boolean {
    if (k.status.has(pokemon.status) || k.ability.has(pokemon.ability) || k.item.has(pokemon.item) ||
      k.species.has(pokemon.baseSpecies.id)) return true;
    for (const id in pokemon.volatiles) if (k.volatile.has(id) || id.includes(':')) return true;
    const sc = pokemon.side.slotConditions[pokemon.position];
    for (const id in sc) if (k.volatile.has(id) || k.side.has(id)) return true;
    return false;
  }
  function sideHas(side: any, k: Kinds): boolean {
    for (const id in side.sideConditions) if (k.side.has(id)) return true;
    return false;
  }
  function fieldHas(field: any, k: Kinds): boolean {
    if (k.field.has(field.weather) || k.field.has(field.terrain)) return true;
    for (const id in field.pseudoWeather) if (k.field.has(id)) return true;
    return false;
  }

  P.findPokemonEventHandlers = function (pokemon: any, callbackName: string, getKey?: string) {
    if (getKey) return origPokemon.call(this, pokemon, callbackName, getKey);
    const k = INDEX.get(callbackName);
    if (!k || !pokemonHas(pokemon, k)) return [];
    return origPokemon.call(this, pokemon, callbackName, getKey);
  };
  P.findSideEventHandlers = function (side: any, callbackName: string, getKey?: string, customHolder?: any) {
    if (getKey) return origSide.call(this, side, callbackName, getKey, customHolder);
    const k = INDEX.get(callbackName);
    if (!k || !sideHas(side, k)) return [];
    return origSide.call(this, side, callbackName, getKey, customHolder);
  };
  P.findFieldEventHandlers = function (field: any, callbackName: string, getKey?: string, customHolder?: any) {
    if (getKey) return origField.call(this, field, callbackName, getKey, customHolder);
    const k = INDEX.get(callbackName);
    if (!k || !fieldHas(field, k)) return [];
    return origField.call(this, field, callbackName, getKey, customHolder);
  };

  // イベント名ごとの、処理名と一覧の覚え書き
  interface EvInfo {
    on: string; onAlly: string; onAny: string; onFoe: string; onSource: string; prefixed: boolean;
    kOn?: Kinds; kAlly?: Kinds; kAny?: Kinds; kFoe?: Kinds; kSource?: Kinds;
  }
  const EV = new Map<string, EvInfo>();
  const NOT_PREFIXED = new Set(['BeforeTurn', 'Update', 'Weather', 'WeatherChange', 'TerrainChange']);
  function evInfo(eventName: string): EvInfo {
    let e = EV.get(eventName);
    if (!e) {
      const on = `on${eventName}`, onAlly = `onAlly${eventName}`, onAny = `onAny${eventName}`, onFoe = `onFoe${eventName}`, onSource = `onSource${eventName}`;
      e = { on, onAlly, onAny, onFoe, onSource, prefixed: !NOT_PREFIXED.has(eventName),
        kOn: INDEX.get(on), kAlly: INDEX.get(onAlly), kAny: INDEX.get(onAny), kFoe: INDEX.get(onFoe), kSource: INDEX.get(onSource) };
      EV.set(eventName, e);
    }
    return e;
  }
  function pushPokemon(battle: any, out: any[], p: any, name: string, k: Kinds | undefined) {
    if (!k || !pokemonHas(p, k)) return;
    const hs = origPokemon.call(battle, p, name);
    for (let i = 0; i < hs.length; i++) out.push(hs[i]);
  }
  function pushSide(battle: any, out: any[], sd: any, name: string, k: Kinds | undefined) {
    if (!k || !sideHas(sd, k)) return;
    const hs = origSide.call(battle, sd, name);
    for (let i = 0; i < hs.length; i++) out.push(hs[i]);
  }
  const { Pokemon } = PS;
  const SideClass = PS.Side;

  // Showdown の findEventHandlers と同じ順に処理先を集める（中身は元の関数に任せ、持たない所は飛ばす）。
  P.findEventHandlers = function (target: any, eventName: string, source?: any) {
    if (Array.isArray(target)) {
      let handlers: any[] = [];
      for (const [i, pokemon] of target.entries()) {
        const cur = this.findEventHandlers(pokemon, eventName, source);
        for (const h of cur) { h.target = pokemon; h.index = i; }
        handlers = handlers.concat(cur);
      }
      return handlers;
    }
    const e = evInfo(eventName);
    const out: any[] = [];
    const shouldBubbleDown = target instanceof SideClass;
    if (target instanceof Pokemon && (target.isActive || source?.isActive)) {
      pushPokemon(this, out, target, e.on, e.kOn);
      if (e.prefixed) {
        for (const ally of target.alliesAndSelf()) { pushPokemon(this, out, ally, e.onAlly, e.kAlly); pushPokemon(this, out, ally, e.onAny, e.kAny); }
        for (const foe of target.foes()) { pushPokemon(this, out, foe, e.onFoe, e.kFoe); pushPokemon(this, out, foe, e.onAny, e.kAny); }
      }
      target = target.side;
    }
    if (source && e.prefixed) pushPokemon(this, out, source, e.onSource, e.kSource);
    if (target instanceof SideClass) {
      for (const side of this.sides) {
        if (shouldBubbleDown) {
          for (const active of side.active) {
            if (side === target || side === target.allySide) pushPokemon(this, out, active, e.on, e.kOn);
            else if (e.prefixed) pushPokemon(this, out, active, e.onFoe, e.kFoe);
            if (e.prefixed) pushPokemon(this, out, active, e.onAny, e.kAny);
          }
        }
        if (side.n < 2 || !side.allySide) {
          if (side === target || side === target.allySide) pushSide(this, out, side, e.on, e.kOn);
          else if (e.prefixed) pushSide(this, out, side, e.onFoe, e.kFoe);
          if (e.prefixed) pushSide(this, out, side, e.onAny, e.kAny);
        }
      }
    }
    if (e.kOn && fieldHas(this.field, e.kOn)) { const hs = origField.call(this, this.field, e.on); for (let i = 0; i < hs.length; i++) out.push(hs[i]); }
    const hb = origBattle.call(this, e.on); for (let i = 0; i < hb.length; i++) out.push(hb[i]);
    return out;
  };
}
