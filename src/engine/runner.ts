// エンジンの入口：盤面（Position）を Showdown の Battle 上に再現し、行動を打って結果（Outcome）を読み出す。
// Showdown 本体（PS）は外から渡す（Node では vendor/showdown、ブラウザでは段階4で組み立てる）。
import type { Position, PosMon, Action, Outcome, OutcomeMon, PosSide } from './position.ts';
import { TRACKED_VOLATILES, TRACKED_SIDE, toID } from './position.ts';

export function makeRunner(PS: any, FORMAT: string) {
  const dex = PS.Dex.forFormat(FORMAT);

  function toSet(m: PosMon) {
    return {
      name: '', species: m.set.species, item: m.set.item, ability: m.set.ability, nature: m.set.nature,
      evs: m.set.evs, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }, moves: m.set.moves, level: 50, gender: 'M',
    };
  }

  /** Showdown の Pokemon が、盤面の何番かを返す（元の種族名で対応させる）。 */
  function indexOf(side: PosSide, p: any): number {
    const base = toID(p.baseSpecies.baseSpecies);
    return side.mons.findIndex(m => toID(dex.species.get(m.set.species).baseSpecies) === base);
  }

  class ShowdownRunner {
    battle: any;
    pos: Position;
    constructor(pos: Position, seed: number) {
      this.pos = pos;
      const s = [seed & 0xffff, (seed >>> 16) & 0xffff, (seed * 7 + 13) & 0xffff, (seed * 31 + 101) & 0xffff];
      const b = new PS.Battle({ formatid: FORMAT, seed: s.join(',') });
      this.battle = b;
      b.setPlayer('p1', { name: 'p1', team: PS.Teams.pack(pos.sides[0].mons.map(toSet)) });
      b.setPlayer('p2', { name: 'p2', team: PS.Teams.pack(pos.sides[1].mons.map(toSet)) });
      // 先発を盤面の active にする並びで選ぶ
      for (const [i, side] of pos.sides.entries()) {
        const order = [side.active, ...[0, 1, 2].filter(x => x !== side.active)].map(x => x + 1).join('');
        b.choose(i === 0 ? 'p1' : 'p2', `team ${order}`);
      }
      this.applyState();
    }

    private applyState() {
      const b = this.battle;
      const pos = this.pos;
      // 場（天気・フィールド・トリックルーム）を盤面どおりに置き直す
      b.field.weather = ''; b.field.weatherState = b.initEffectState({ id: '' });
      b.field.terrain = ''; b.field.terrainState = b.initEffectState({ id: '' });
      b.field.pseudoWeather = {};
      const f = pos.field ?? {};
      if (f.weather) { b.field.weather = f.weather.id; b.field.weatherState = b.initEffectState({ id: f.weather.id, duration: f.weather.turns, target: b.field }); }
      if (f.terrain) { b.field.terrain = f.terrain.id; b.field.terrainState = b.initEffectState({ id: f.terrain.id, duration: f.terrain.turns, target: b.field }); }
      if (f.trickroom) b.field.pseudoWeather.trickroom = b.initEffectState({ id: 'trickroom', duration: f.trickroom, target: b.field });

      for (const [si, ps] of pos.sides.entries()) {
        const side = b.sides[si];
        const foe = b.sides[1 - si];
        side.sideConditions = {};
        const c = ps.cond ?? {};
        const put = (id: string, extra: any) => {
          side.sideConditions[id] = b.initEffectState({ id, target: side, source: foe.active[0], sourceSlot: foe.active[0].getSlot(), ...extra });
        };
        if (c.stealthrock) put('stealthrock', {});
        if (c.spikes) put('spikes', { layers: c.spikes });
        if (c.toxicspikes) put('toxicspikes', { layers: c.toxicspikes });
        if (c.stickyweb) put('stickyweb', {});
        if (c.reflect) put('reflect', { duration: c.reflect });
        if (c.lightscreen) put('lightscreen', { duration: c.lightscreen });
        if (c.auroraveil) put('auroraveil', { duration: c.auroraveil });
        if (c.tailwind) put('tailwind', { duration: c.tailwind });

        for (const p of side.pokemon) {
          const i = indexOf(ps, p);
          const m = ps.mons[i];
          if (m.mega) {
            const forme = b.actions.canMegaEvo(p);
            if (!forme) throw new Error(`メガシンカできない：${m.set.species}`);
            p.formeChange(forme, p.getItem(), true);
          }
          if (ps.megaUsed || m.mega) for (const q of side.pokemon) q.canMegaEvo = false;
          if (m.itemGone) { p.item = ''; p.itemState = b.initEffectState({ id: '', target: p }); }
          p.hp = Math.min(m.hp, p.maxhp);
          if (p.hp <= 0) { p.hp = 0; p.fainted = true; p.status = 'fnt'; side.pokemonLeft--; }
          else {
            p.status = m.status;
            const st: any = { id: m.status, target: p };
            if (m.status === 'slp' || m.status === 'frz') { st.time = m.statusTime ?? 2; st.startTime = st.time; }
            if (m.status === 'tox') st.stage = m.statusTime ?? 0;
            p.statusState = b.initEffectState(st);
          }
          p.boosts = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0, ...(m.boosts ?? {}) };
          if (m.pp) m.pp.forEach((pp, k) => { if (p.moveSlots[k]) p.moveSlots[k].pp = pp; });
          if (p.isActive) {
            p.volatiles = {};
            const v = m.vol ?? {};
            const vol = (id: string, extra: any) => {
              p.volatiles[id] = b.initEffectState({ id, name: dex.conditions.get(id).name, target: p, source: foe.active[0], sourceSlot: foe.active[0].getSlot(), ...extra });
            };
            if (v.substitute) vol('substitute', { hp: v.substitute });
            if (v.confusion) vol('confusion', { time: v.confusion });
            if (v.leechseed) vol('leechseed', {});
            if (v.taunt) vol('taunt', { duration: v.taunt });
            if (v.choicelock) vol('choicelock', { move: toID(v.choicelock) });
            if (v.yawn) vol('yawn', { duration: v.yawn });
            if (v.focusenergy) vol('focusenergy', {});
            if (v.curse) vol('curse', {});
          }
        }
      }
      for (const p of b.getAllActive()) p.updateSpeed();
      b.makeRequest('move');
    }

    /** Showdown の選び方の文字列にする。 */
    private choiceString(si: number, a: Action): string {
      const side = this.battle.sides[si];
      if (a.kind === 'move') return `move ${a.slot + 1}${a.mega ? ' mega' : ''}`;
      const k = side.pokemon.findIndex((p: any) => indexOf(this.pos.sides[si], p) === a.to);
      return `switch ${k + 1}`;
    }

    /** 今の要求に対して選べる行動の一覧（Showdown が基準）。 */
    legalActions(si: number): Action[] {
      const side = this.battle.sides[si];
      const req = side.activeRequest;
      if (!req || req.wait) return [];
      const out: Action[] = [];
      const ps = this.pos.sides[si];
      const switches = () => side.pokemon.forEach((p: any, k: number) => {
        if (k >= 1 && !p.fainted && !p.isActive) out.push({ kind: 'switch', to: indexOf(ps, p) });
      });
      if (req.forceSwitch) { switches(); return out; }
      const act = req.active[0];
      if (act.moves.length === 1 && (act.moves[0].id === 'struggle' || act.moves[0].maxpp === undefined)) {
        // わるあがき、または固定された技（あばれる等）
        out.push({ kind: 'move', slot: 0 });
      } else {
        act.moves.forEach((m: any, k: number) => {
          if (m.disabled) return;
          out.push({ kind: 'move', slot: k });
          if (act.canMegaEvo) out.push({ kind: 'move', slot: k, mega: true });
        });
      }
      if (!act.trapped) switches();
      return out;
    }

    /** 両者の行動を打ち、途中の交代は「番号の小さい控え」を選んで、次のターンの選択か決着まで進める。 */
    play(a0: Action | null, a1: Action | null, maxSteps = 6) {
      const b = this.battle;
      if (a0) b.choose('p1', this.choiceString(0, a0));
      if (a1) b.choose('p2', this.choiceString(1, a1));
      for (let step = 0; step < maxSteps && !b.ended && b.requestState === 'switch'; step++) {
        for (let si = 0; si < 2; si++) {
          const side = b.sides[si];
          if (!side.activeRequest || side.activeRequest.wait) continue;
          const opts = this.legalActions(si).filter(x => x.kind === 'switch') as { kind: 'switch'; to: number }[];
          opts.sort((x, y) => x.to - y.to);
          b.choose(side.id, opts.length ? this.choiceString(si, opts[0]) : 'pass');
        }
      }
    }

    outcome(): Outcome {
      const b = this.battle;
      const sides = b.sides.map((side: any, si: number) => {
        const ps = this.pos.sides[si];
        const mons: OutcomeMon[] = ps.mons.map(() => null as any);
        for (const p of side.pokemon) {
          const i = indexOf(ps, p);
          const boosts = Object.entries(p.boosts).filter(([, v]) => v).map(([k, v]) => `${k}${(v as number) > 0 ? '+' : ''}${v}`).join(',');
          let status = p.fainted ? 'fnt' : p.status;
          if (status === 'slp' || status === 'frz') status += p.statusState.time;
          if (status === 'tox') status += p.statusState.stage;
          const vols = p.isActive ? volString(p.volatiles) : '';
          mons[i] = { hp: p.hp, status, boosts, item: p.item, species: p.species.id, vols };
        }
        const cond: Record<string, number> = {};
        for (const id of TRACKED_SIDE) {
          const s = side.sideConditions[id] ?? side.slotConditions?.[0]?.[id];
          if (s) cond[id] = s.layers ?? s.duration ?? 1;
        }
        return { active: indexOf(ps, side.active[0]), cond, mons };
      });
      const w = b.winner ? (b.winner === 'p1' ? 0 : b.winner === 'p2' ? 1 : null) : null;
      return {
        ended: !!b.ended, winner: w, sides,
        field: {
          weather: b.field.weather, weatherTurns: b.field.weatherState.duration ?? 0,
          terrain: b.field.terrain, terrainTurns: b.field.terrainState.duration ?? 0,
          trickroom: b.field.pseudoWeather.trickroom?.duration ?? 0,
        },
      };
    }
  }

  return ShowdownRunner;
  }

  export type Runner = InstanceType<ReturnType<typeof makeRunner>>;

  function volString(v: Record<string, any>): string {
    const parts: string[] = [];
    for (const id of TRACKED_VOLATILES) {
      const s = v[id];
      if (!s) continue;
      let x = '';
      if (id === 'substitute') x = String(s.hp);
      else if (id === 'confusion') x = String(s.time);
      else if (id === 'choicelock') x = s.move;
      else if (id === 'stall') x = String(s.counter);
      else if (s.duration !== undefined) x = String(s.duration);
      parts.push(x ? `${id}:${x}` : id);
    }
    return parts.join(',');
  }
