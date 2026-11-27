// 対戦の記録係：入力されたターンから今の盤面を作り、相手の型の推定に手がかりを渡し、探索用の仮の盤面を作る。
// - ターンは、記録の出る Showdown（速さの層なし）で、相手の型を「今いちばんありそうな型」にして何通りか打ち直し、
//   見えた結果（どちらが先、HP、急所、場の体、状態異常）にいちばん合う展開を選ぶ。能力ランク・天気・まきびし等はその展開から取る。
//   見えた数字（HP、状態異常、場の体）は入力の値で上書きする。
// - 相手のHPは割合（%）で持ち、仮の盤面を作るときに、その型の最大HPで実数に直す。
import { makeRunner } from '../engine/runner.ts';
import type { Position, PosMon, PosSide, MonSet, StatusID, Action } from '../engine/position.ts';
import { expandPrior, OpponentSet, clueItem, clueAbility, type PriorEntry } from '../infer/sets.ts';
void clueAbility;
import { makeCalc, shownPercent } from '../infer/calc.ts';
import { BenchModel } from '../infer/bench.ts';

const toID = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

export interface BattleSetup {
  ours: MonSet[];          // こちらの選出3体（並びはこの順。番号はこの並び）
  ourLead: number;
  oppSpecies: string[];    // 相手の6体（英語名。番号はこの並び）
  ourTeamJa: string[];     // こちらの6体の日本語名（選出の出し分けの照合用）
}
export type OppAction = { kind: 'move'; move: string; mega?: boolean } | { kind: 'switch'; to: number } | { kind: 'none' };
export type OurAction = Action | { kind: 'none' };
export interface TurnInput {
  ours: OurAction;
  opp: OppAction;
  first?: 'us' | 'them';           // 両方が技を出したとき、どちらが先だったか
  critOnOpp?: boolean;             // こちらの攻撃が急所だった
  critOnUs?: boolean;              // 相手の攻撃が急所だった
  oppItem?: string;                // 相手の持ち物の発動（英語名）
  oppAbility?: string;             // 相手の特性の発動（英語名）
  ourMega?: boolean;               // こちらがこのターンにメガシンカした（技を出せなくてもメガシンカは起きる）
  oppMega?: boolean;               // 相手がこのターンにメガシンカした
  after: { ourActive: number; ourHp: number; ourStatus: StatusID; oppActive: number; oppHpPct: number; oppStatus: StatusID; ourHps?: number[] };
  visible?: VisibleState;
}
/** 画面に見える状態（「今の状態」欄で確かめ・直したもの）。入っていれば、再現の値を上書きする。 */
export interface VisibleState {
  boosts?: [Partial<Record<string, number>>, Partial<Record<string, number>>];   // こちらの場の体、相手の場の体
  weather?: string; terrain?: string; trickroom?: boolean;                        // '' はなし
  cond?: [Record<string, number>, Record<string, number>];                        // まきびし等（層の数か、ある=1）
  vol?: [{ leechseed?: boolean; substitute?: boolean }, { leechseed?: boolean; substitute?: boolean }];  // 場の体のやどりぎのタネ・みがわり
  ourItem?: string;   // こちらの場の体が今持っている持ち物（id、'' はなし）。トリック等で変わったとき用
}
export interface StartInput { oppLead: number; oppAbility?: string; oppItem?: string }

interface OppMonState { seen: boolean; hpPct: number; status: StatusID; fainted: boolean }

export function makeAnalyzer(PS: any, FORMAT: string, priors: { species: Record<string, PriorEntry> }, teams: any[], selections: any[]) {
  const Runner = makeRunner(PS, FORMAT);
  const dex = PS.Dex.forFormat(FORMAT);
  const calc = makeCalc(PS, FORMAT);
  const bench = new BenchModel(teams, selections);
  const maxhpOf = (set: MonSet) => dex.species.get(set.species).baseStats.hp + set.evs.hp + 75;

  // 使った側のHPがそのターンのうちに動く技（回復・吸い取り・反動・やどりぎのタネ・みがわり等）
  const SELF_HP = new Set(['synthesis', 'moonlight', 'morningsun', 'shoreup', 'strengthsap', 'rest', 'painsplit', 'wish', 'leechseed', 'ingrain', 'aquaring',
    'substitute', 'bellydrum', 'filletaway', 'clangoroussoul', 'curse', 'steelbeam', 'mindblown', 'chloroblast', 'healingwish', 'lunardance', 'memento', 'finalgambit',
    'explosion', 'selfdestruct', 'mistyexplosion', 'highjumpkick', 'jumpkick', 'shedtail', 'junglehealing', 'lifedew', 'swallow', 'milkdrink', 'softboiled', 'recover', 'slackoff', 'roost']);
  const selfHpMove = (m: string) => { const mv = dex.moves.get(m); return !!(mv.drain || mv.recoil || mv.heal || mv.selfdestruct || mv.hasCrashDamage || mv.mindBlownRecoil || SELF_HP.has(mv.id)); };

  return class Analyzer {
    setup: BattleSetup;
    opp: OppMonState[];
    sets: OpponentSet[];               // 相手の6体それぞれの型の推定
    benchDist: Map<string, number>;
    pos!: Position;                    // 今の盤面（相手の型は「いちばんありそうな型」で置いたもの）
    oppOrder: number[] = [];           // pos.sides[1].mons の各体が、相手の6体の何番か
    turn = 0;
    notes: string[] = [];              // 直近のターンの再現についての注意
    itemChanged: boolean[] = [false, false, false, false, false, false]; // トリック等で持ち物が入れ替わったかもしれない体
    itemGone: boolean[] = [false, false, false, false, false, false];    // 持ち物がなくなったのが画面で見えた体（使い切りの持ち物の発動、はたきおとす）
    constructor(setup: BattleSetup) {
      this.setup = setup;
      this.opp = setup.oppSpecies.map(() => ({ seen: false, hpPct: 100, status: '', fainted: false }));
      this.sets = setup.oppSpecies.map(sp => new OpponentSet(expandPrior(priors.species[toID(sp)] ?? priors.species[toID(dex.species.get(sp).baseSpecies)])));
      this.benchDist = bench.prior(setup.oppSpecies, setup.ourTeamJa);
    }

    /** 相手の体 i の、今いちばんありそうな型（見えた技を必ず含める）。 */
    mapSet(i: number, mustMove?: string): MonSet {
      const s = this.sets[i];
      const post = s.posterior() ?? s.cands.map(c => c.prior);
      let best = 0; post.forEach((p, k) => { if (p > post[best]) best = k; });
      const c = s.cands[best];
      let moves = c.generic ? [...s.moves] : [...c.moves];
      if (c.generic) { const probs = [...s.moveProbabilities().keys()]; for (const m of probs) if (moves.length < 4 && !moves.includes(m)) moves.push(m); }
      for (const m of [...s.moves, ...(mustMove ? [mustMove] : [])]) if (!moves.some(x => toID(x) === toID(m))) { if (moves.length >= 4) moves.pop(); moves.unshift(m); }
      return { species: this.setup.oppSpecies[i], item: toID(c.item), ability: toID(c.ability), nature: c.nature, evs: c.evs, moves: moves.slice(0, 4).map(toID) };
    }

    /** 相手の選出の3体（見えた体＋ありそうな体）。 */
    oppTrio(): number[] {
      const seen = this.opp.map((o, i) => o.seen ? i : -1).filter(i => i >= 0);
      const inc = BenchModel.inclusion(this.benchDist, seen);
      const rest = [0, 1, 2, 3, 4, 5].filter(i => !seen.includes(i)).sort((a, b) => inc[b] - inc[a]);
      return [...seen, ...rest].slice(0, 3);
    }

    /** 対戦の始まり：先発を出した直後の盤面を作る（特性の効果も入る）。 */
    start(s: StartInput) {
      this.opp[s.oppLead].seen = true;
      if (s.oppAbility) this.sets[s.oppLead].add(clueAbility(s.oppAbility));
      if (s.oppItem) this.sets[s.oppLead].add(clueItem(s.oppItem));
      const trio = this.oppTrio().filter(i => i !== s.oppLead);
      this.oppOrder = [s.oppLead, ...trio].slice(0, 3);
      const pos: Position = {
        sides: [
          { mons: this.setup.ours.map(set => ({ set, hp: maxhpOf(set), status: '' as StatusID })), active: this.setup.ourLead },
          { mons: this.oppOrder.map(i => ({ set: this.mapSet(i), hp: 0, status: '' as StatusID })), active: 0 },
        ],
      };
      for (const m of pos.sides[1].mons) m.hp = maxhpOf(m.set);
      const r = new Runner(pos, 1, true);
      this.pos = r.toPosition();
    }

    /** pos の相手側を、今の推定（いちばんありそうな型）と見えている HP% で作り直す。order は相手の6体の番号。 */
    private oppSide(order: number[], from: Position, sets: (i: number) => MonSet): PosSide {
      const old = from.sides[1];
      const byIdx = new Map(this.oppOrder.map((oi, k) => [oi, old.mons[k]]));
      const mons: PosMon[] = order.map(i => {
        const set = sets(i);
        const prev = byIdx.get(i);
        const o = this.opp[i];
        const hp = o.fainted ? 0 : Math.max(1, Math.round(maxhpOf(set) * o.hpPct / 100));
        const m: PosMon = { set, hp, status: o.fainted ? '' : o.status };
        if (this.itemGone[i]) m.itemGone = true;
        if (prev) { if (prev.boosts) m.boosts = prev.boosts; if (prev.vol) m.vol = prev.vol; if (prev.mega) m.mega = true; if (prev.forme) m.forme = prev.forme; if (prev.statusTime !== undefined) m.statusTime = prev.statusTime; }
        return m;
      });
      const activeIdx = this.oppOrder[old.active];
      return { mons, active: Math.max(0, order.indexOf(activeIdx)), megaUsed: old.megaUsed, cond: old.cond };
    }

    /** 1ターンを記録する。 */
    record(t: TurnInput) {
      this.turn++;
      this.notes = [];
      const start = this.pos;
      const oppActiveIdx = this.oppOrder[start.sides[1].active];
      const beforePct = this.opp[oppActiveIdx].hpPct;
      // 交代先が新しく見えた体なら、相手の3体に入れる
      const newOpp = [t.opp.kind === 'switch' ? t.opp.to : -1, t.after.oppActive].filter(i => i >= 0);
      for (const i of newOpp) this.opp[i].seen = true;
      const trio = this.oppTrio();
      const order = [oppActiveIdx, ...trio.filter(i => i !== oppActiveIdx)].slice(0, 3);
      // 手がかり（再現の前に、行動の順番・技・持ち物・特性）
      const oppMove = t.opp.kind === 'move' ? t.opp.move : undefined;
      const os = this.sets[oppActiveIdx];
      const oppSp = dex.species.get(this.setup.oppSpecies[oppActiveIdx]);
      // メタモン（へんしん）は、こちらの技を使うので、技・順番・ダメージの手がかりにしない
      const transformer = oppSp.baseSpecies === 'Ditto';
      // へんげんじざい・リベロでタイプが変わる（盤面の形がタイプの変化を持たない）ので、ダメージの手がかりにしない
      const typeShifter = Object.values(oppSp.abilities).some((a: any) => ['protean', 'libero'].includes(toID(a)));
      if (oppMove && !transformer && toID(oppMove) !== 'struggle') os.revealMove(oppMove);
      // トリック・すりかえ等で持ち物が入れ替わると、見える持ち物ももとの持ち物ではなくなり、素早さ・ダメージも変わるので、
      // その体については、以後、持ち物・順番・ダメージの手がかりを使わない
      const SWAP = ['trick', 'switcheroo', 'thief', 'covet', 'bestow'];
      const ourMoveId = t.ours.kind === 'move' ? start.sides[0].mons[start.sides[0].active].set.moves[t.ours.slot] : '';
      const swapNow = (oppMove && SWAP.includes(toID(oppMove))) || SWAP.includes(toID(ourMoveId ?? ''));
      const itemFrozen = this.itemChanged[oppActiveIdx] || swapNow;
      if (swapNow) this.itemChanged[oppActiveIdx] = true;
      if (t.oppItem && !this.itemChanged[t.after.oppActive] && !(t.after.oppActive === oppActiveIdx && itemFrozen)) this.sets[t.after.oppActive].add(clueItem(t.oppItem));
      // 使い切りの持ち物の発動が見えたら、その体の持ち物はなくなった
      if (t.oppItem) {
        const it = dex.items.get(t.oppItem);
        if (it.isBerry || ['focussash', 'airballoon', 'whiteherb', 'mentalherb', 'powerherb', 'redcard', 'ejectbutton', 'ejectpack', 'weaknesspolicy', 'boosterenergy', 'roomservice', 'throatspray', 'adrenalineorb', 'blunderpolicy', 'mirrorherb', 'cellbattery', 'absorbbulb', 'snowball', 'luminousmoss'].includes(it.id)) this.itemGone[t.after.oppActive] = true;
      }
      const abOwner = dex.species.get(this.setup.oppSpecies[t.after.oppActive]);
      const possibleAb = new Set<string>([...Object.values(abOwner.abilities).map((a: any) => toID(a))]);
      for (const it of dex.items.all()) if (it.megaStone) for (const [from, f] of Object.entries(it.megaStone) as [string, string][]) if (dex.species.get(from).baseSpecies === abOwner.baseSpecies) possibleAb.add(toID(dex.species.get(f).abilities['0']));
      // その種族（とメガシンカ）が持てない特性が見えたときは、トレース等で写したものなので、手がかりにしない
      if (t.oppAbility && possibleAb.has(toID(t.oppAbility))) {
        // メガシンカした後の特性も見えるので、メガストーンを持つ候補はメガシンカ後の特性とも比べる
        const ab = toID(t.oppAbility);
        this.sets[t.after.oppActive].add({ label: `特性が ${t.oppAbility}`, like: c => {
          if (toID(c.ability) === ab) return 1;
          const it = dex.items.get(c.item);
          return it.megaStone && Object.values(it.megaStone).some((f: any) => toID(dex.species.get(f).abilities['0']) === ab) ? 1 : 0;
        } });
      }
      const oppMega = t.oppMega || (t.opp.kind === 'move' && !!t.opp.mega);
      const ourMega = t.ourMega || (t.ours.kind === 'move' && !!(t.ours as any).mega);
      if (oppMega) {
        const stones = dex.items.all().filter((it: any) => it.megaStone && Object.keys(it.megaStone).some((k: string) => toID(k) === toID(this.setup.oppSpecies[oppActiveIdx])));
        // メガストーンが2つある種族（リザードン等）も、どちらかを持つことは分かる
        if (stones.length === 1) os.add(clueItem(stones[0].name));
        else if (stones.length > 1) { const ids = stones.map((it: any) => it.id); os.add({ label: `持ち物が ${stones.map((it: any) => it.name).join('・')} のどれか`, like: c => ids.includes(toID(c.item)) ? 1 : 0 }); }
      }
      if (toID(ourMoveId ?? '') === 'knockoff' && t.after.oppActive === oppActiveIdx && t.after.oppHpPct < beforePct) this.knockedPending = oppActiveIdx;
      const startPos: Position = { ...start, sides: [start.sides[0], this.oppSide(order, start, i => this.mapSet(i, i === oppActiveIdx ? oppMove : undefined))] };
      // メガシンカは技より先に起きるので、順番とダメージの手がかりはメガシンカした後の姿で計算する
      const clueStart: Position = JSON.parse(JSON.stringify(startPos));
      if (oppMega) { const s1 = clueStart.sides[1]; s1.mons[s1.active].mega = true; s1.megaUsed = true; }
      if (ourMega) { const s0 = clueStart.sides[0]; s0.mons[s0.active].mega = true; s0.megaUsed = true; }
      if (t.ours.kind === 'move' && t.opp.kind === 'move' && t.first) {
        const ourMove = startPos.sides[0].mons[startPos.sides[0].active].set.moves[t.ours.slot];
        // こちらのアンコールが先に当たると、相手の技が差し替わるので、順番の手がかりにしない
        if (ourMove && !transformer && !itemFrozen && !(toID(ourMove) === 'encore' && t.first === 'us')) os.add(calc.clueOrder(clueStart, 0, this.setup.oppSpecies[oppActiveIdx], ourMove, t.opp.move, t.first === 'them'));
      }
      // 再現：相手の型をもう一度「いちばんありそうな型」にして、何通りか打ち直す
      const replayPos: Position = { ...start, sides: [start.sides[0], this.oppSide(order, start, i => this.mapSet(i, i === oppActiveIdx ? oppMove : undefined))] };
      this.oppOrder = order;
      const oppAct = (r: any): Action | null => {
        if (t.opp.kind === 'none') return null;
        if (t.opp.kind === 'switch') return { kind: 'switch', to: order.indexOf(t.opp.to) };
        const set = replayPos.sides[1].mons[replayPos.sides[1].active].set;
        const k = set.moves.findIndex(m => toID(m) === toID((t.opp as any).move));
        return { kind: 'move', slot: Math.max(0, k), mega: !!t.opp.mega };
      };
      let best: { score: number; pos: Position; log: string[] } | null = null;
      for (let seed = 1; seed <= 48; seed++) {
        let r;
        try { r = new Runner(replayPos, seed); } catch (e: any) { this.notes.push(`再現できない：${e.message}`); break; }
        const ours = t.ours.kind === 'none' ? null : t.ours as Action;
        const legal0 = r.legalActions(0), legal1 = r.legalActions(1);
        const a0 = ours && legal0.some(x => JSON.stringify(x) === JSON.stringify(ours)) ? ours : (legal0[0] ?? null);
        const want1 = oppAct(r);
        const a1 = want1 && legal1.some(x => JSON.stringify(x) === JSON.stringify(want1)) ? want1 : (legal1[0] ?? null);
        try { r.play(a0, a1, 6, [t.after.ourActive, order.indexOf(t.after.oppActive)]); } catch { continue; }
        const log: string[] = r.battle.log;
        const p = r.toPosition();
        const score = this.mismatch(t, p, log, order);
        if (!best || score < best.score) best = { score, pos: p, log };
        if (score === 0) break;
      }
      if (!best) { this.notes.push('このターンを Showdown で再現できませんでした。盤面は入力の値だけで作ります。'); best = { score: 99, pos: replayPos, log: [] }; }
      // HP の少しの違いは、相手の型を推定で置いているので起きる。場の体・状態異常・順番・急所が合わないときだけ知らせる
      if (best.score >= 1) this.notes.push(`入力と合う再現が見つかりませんでした（ずれの点数 ${best.score.toFixed(2)}）。能力ランクや場の状態を確かめてください。`);
      // 見えた値で上書き
      const pos = best.pos;
      const us = pos.sides[0];
      us.active = t.after.ourActive;
      if (t.after.ourHps) t.after.ourHps.forEach((hp, k) => { us.mons[k].hp = hp; if (hp <= 0) us.mons[k].status = ''; });
      const ua = us.mons[us.active]; ua.hp = t.after.ourHp; ua.status = t.after.ourStatus;
      const oa = this.opp[t.after.oppActive];
      oa.hpPct = t.after.oppHpPct; oa.status = t.after.oppStatus; oa.fainted = t.after.oppHpPct <= 0;
      // 相手が倒れた体
      for (const [k, i] of order.entries()) if (pos.sides[1].mons[k].hp <= 0 && i !== t.after.oppActive) { this.opp[i].fainted = true; this.opp[i].hpPct = 0; }
      for (const [k, i] of order.entries()) if (i !== t.after.oppActive && !this.opp[i].fainted && this.opp[i].seen) this.opp[i].hpPct = shownPercent(pos.sides[1].mons[k].hp, maxhpOf(pos.sides[1].mons[k].set));
      pos.sides[1].active = Math.max(0, order.indexOf(t.after.oppActive));
      pos.sides[1].mons[pos.sides[1].active].status = t.after.oppStatus;
      // メガシンカは画面に出るので、入力どおりにする
      if (ourMega) { const m = pos.sides[0].mons[start.sides[0].active]; m.mega = true; pos.sides[0].megaUsed = true; }
      if (oppMega) { const k = order.indexOf(oppActiveIdx); if (k >= 0) { pos.sides[1].mons[k].mega = true; pos.sides[1].megaUsed = true; } }
      if (t.visible) this.applyVisible(pos, t.visible);
      this.pos = pos;
      // ダメージの手がかり（相手の%）：相手がそのターンに自分のHPを動かすことがない、と言えるときだけ
      // 相手が先に動いた技（おにび・リフレクター等）で状態が変わってから当たることがあるので、こちらが先に動いたか、相手が動かなかったときだけ使う
      if (t.ours.kind === 'move' && t.after.oppActive === oppActiveIdx && t.opp.kind !== 'switch' && (t.first === 'us' || t.opp.kind === 'none')) {
        const ourSet = startPos.sides[0].mons[startPos.sides[0].active].set;
        const mv = dex.moves.get(ourSet.moves[t.ours.slot]);
        const before = beforePct;
        const ourA = startPos.sides[0].mons[startPos.sides[0].active].set;
        const contact = oppMove ? !!dex.moves.get(oppMove).flags?.contact : false;
        const ourStartMon = start.sides[0].mons[start.sides[0].active];
        // メガシンカした（ひでり等で天気が変わる）、またはターンの終わりの天気・フィールドが始めと違うときも使わない
        const fieldChanged = oppMega || ourMega || (t.visible?.weather !== undefined && (t.visible.weather || '') !== (start.field?.weather?.id ?? '')) || (t.visible?.terrain !== undefined && (t.visible.terrain || '') !== (start.field?.terrain?.id ?? ''));
        const quiet = !fieldChanged && !ourStartMon.vol?.leechseed && !(contact && (ourA.item === 'rockyhelmet' || ['roughskin', 'ironbarbs'].includes(ourA.ability))) && !t.oppItem && !this.opp[oppActiveIdx].status && !start.field?.weather && !start.field?.terrain && !start.sides[1].mons[start.sides[1].active].vol?.leechseed &&
          !(oppMove && selfHpMove(oppMove));
        const oppStartMon = start.sides[1].mons[start.sides[1].active];
        // みがわりがあるとき、ばけのかわ・アイスフェイスがはがれていないときは、HPの減り方が技のダメージにならない
        const shielded = !!oppStartMon.vol?.substitute || (['Mimikyu', 'Eiscue'].includes(dex.species.get(this.setup.oppSpecies[oppActiveIdx]).baseSpecies) && !oppStartMon.forme);
        if (quiet && !shielded && !transformer && !typeShifter && !itemFrozen && mv.category !== 'Status' && !mv.multihit && t.after.oppHpPct < before) {
          os.add(calc.clueDamageToOpp(clueStart, 0, this.setup.oppSpecies[oppActiveIdx], mv.name, before, t.after.oppHpPct, !!t.critOnOpp));
        }
      }
      if (this.knockedPending !== null) { this.itemGone[this.knockedPending] = true; this.knockedPending = null; }
      return { notes: this.notes, score: best.score };
    }
    knockedPending: number | null = null;

    /** 画面に見える状態で上書きする（残りターンは分からないので、同じものが続いていれば再現の値、新しければ5）。 */
    applyVisible(pos: Position, v: VisibleState) {
      if (v.boosts) v.boosts.forEach((b, si) => { const sd = pos.sides[si]; const m = sd.mons[sd.active]; const nb: any = {}; for (const [k, x] of Object.entries(b)) if (x) nb[k] = x; if (Object.keys(nb).length) m.boosts = nb; else delete m.boosts; });
      const f: any = pos.field ?? (pos.field = {});
      if (v.weather !== undefined) f.weather = v.weather ? { id: v.weather, turns: f.weather?.id === v.weather ? f.weather.turns : 5 } : undefined;
      if (v.terrain !== undefined) f.terrain = v.terrain ? { id: v.terrain, turns: f.terrain?.id === v.terrain ? f.terrain.turns : 5 } : undefined;
      if (v.trickroom !== undefined) f.trickroom = v.trickroom ? (f.trickroom || 5) : undefined;
      if (v.ourItem !== undefined) {
        const m = pos.sides[0].mons[pos.sides[0].active];
        delete m.heldItem; delete m.itemGone;
        if (!v.ourItem) m.itemGone = true; else if (toID(v.ourItem) !== toID(m.set.item)) m.heldItem = toID(v.ourItem);
      }
      if (v.vol) v.vol.forEach((x, si) => {
        const sd = pos.sides[si]; const m = sd.mons[sd.active]; const vol: any = { ...(m.vol ?? {}) };
        if (x.leechseed !== undefined) { if (x.leechseed) vol.leechseed = true; else delete vol.leechseed; }
        if (x.substitute !== undefined) { if (x.substitute) vol.substitute = vol.substitute || Math.floor(maxhpOf(m.set) / 4); else delete vol.substitute; }
        if (Object.keys(vol).length) m.vol = vol; else delete m.vol;
      });
      if (v.cond) v.cond.forEach((c, si) => {
        const old: any = pos.sides[si].cond ?? {}, nc: any = {};
        for (const [k, x] of Object.entries(c)) if (x) nc[k] = ['stealthrock', 'stickyweb'].includes(k) ? true : ['spikes', 'toxicspikes'].includes(k) ? x : (old[k] || 5);
        pos.sides[si].cond = nc;
      });
    }

    /** 再現の結果と入力のずれ（0 なら完全に合う）。 */
    private mismatch(t: TurnInput, p: Position, log: string[], order: number[]): number {
      let s = 0;
      const us = p.sides[0], them = p.sides[1];
      if (us.active !== t.after.ourActive) s += 3;
      if (order[them.active] !== t.after.oppActive) s += 3;
      const ua = us.mons[t.after.ourActive];
      s += Math.abs(ua.hp - t.after.ourHp) / maxhpOf(ua.set);
      if ((ua.status || '') !== t.after.ourStatus) s += 1;
      const k = order.indexOf(t.after.oppActive);
      if (k >= 0) {
        const om = them.mons[k];
        s += Math.abs(shownPercent(om.hp, maxhpOf(om.set)) - t.after.oppHpPct) / 100;
        if ((om.status || '') !== t.after.oppStatus) s += 1;
      }
      if (t.first) {
        const f = log.find(l => /^\|move\|p[12]a:/.test(l) && !l.includes('[from]'));
        if (f && (f.startsWith('|move|p2a') ? 'them' : 'us') !== t.first) s += 2;
      }
      const critOnOpp = log.some(l => l.startsWith('|-crit|p2a')), critOnUs = log.some(l => l.startsWith('|-crit|p1a'));
      if (!!t.critOnOpp !== critOnOpp) s += 1;
      if (!!t.critOnUs !== critOnUs) s += 1;
      return s;
    }

    /** 探索用の仮の盤面を k 個作る（相手の控えと型を、今の推定から抜き出す）。 */
    determinizations(k: number, rand: () => number): Position[] {
      const out: Position[] = [];
      const seen = this.opp.map((o, i) => o.seen ? i : -1).filter(i => i >= 0);
      const activeIdx = this.oppOrder[this.pos.sides[1].active];
      for (let n = 0; n < k; n++) {
        // 控え：見えた体を含む3体の組を、選出の推定から抜き出す
        let trio: number[] = [];
        const cands = [...this.benchDist.entries()].filter(([key]) => seen.every(i => key.split(',').map(Number).includes(i)));
        const total = cands.reduce((a, [, v]) => a + v, 0);
        let r = rand() * total;
        for (const [key, v] of cands) { r -= v; if (r <= 0) { trio = key.split(',').map(Number); break; } }
        if (trio.length !== 3) trio = this.oppTrio();
        const order = [activeIdx, ...trio.filter(i => i !== activeIdx)].slice(0, 3);
        const side = this.oppSide(order, this.pos, i => {
          // メガシンカ済みの体は、メガストーンを持つ型だけにする（持たない型が抜き出されたら、いちばんありそうな型にする）
          const m = this.pos.sides[1].mons[this.oppOrder.indexOf(i)];
          let s = this.sets[i].sample(rand);
          if (s && m?.mega && !dex.items.get(s.item).megaStone) s = null;
          return s ? { species: this.setup.oppSpecies[i], item: toID(s.item), ability: toID(s.ability), nature: s.nature, evs: s.evs, moves: s.moves.map(toID) } : this.mapSet(i);
        });
        out.push({ ...this.pos, sides: [this.pos.sides[0], side] });
      }
      return out;
    }

    /** 相手の体 i の推定のまとめ（上位の持ち物・特性・技）。 */
    summary(i: number) {
      const s = this.sets[i];
      const top = (m: Map<string, number>, n: number) => [...m.entries()].slice(0, n).map(([k, v]) => ({ name: k, p: v }));
      return { items: top(s.marginal(c => c.item), 4), abilities: top(s.marginal(c => c.ability), 3), moves: top(s.moveProbabilities(), 8), revealed: [...s.moves], ok: !!s.posterior() };
    }

    /** こちらの選び方の文字列（探索の結果）を、表示用の行動にする。仮の盤面の並び：場の体、残り（番号順）。 */
    describe(choice: string): { kind: 'move'; slot: number; mega: boolean } | { kind: 'switch'; to: number } {
      const us = this.pos.sides[0];
      const [kind, num, mega] = choice.split(' ');
      if (kind === 'move') return { kind: 'move', slot: Number(num) - 1, mega: mega === 'mega' };
      const order = [us.active, ...[0, 1, 2].filter(x => x !== us.active)];
      return { kind: 'switch', to: order[Number(num) - 1] };
    }
  };
}
export type Analyzer = InstanceType<ReturnType<typeof makeAnalyzer>>;
