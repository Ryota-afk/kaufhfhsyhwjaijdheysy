// 対戦の記録係：入力されたターンから今の盤面を作り、相手の型の推定に手がかりを渡し、探索用の仮の盤面を作る。
// - ターンは、記録の出る Showdown（速さの層なし）で、相手の型を「今いちばんありそうな型」にして何通りか打ち直し、
//   見えた結果（どちらが先、HP、急所、場のポケモン、状態異常）にいちばん合う展開を選ぶ。能力ランク・天気・まきびし等はその展開から取る。
//   見えた数字（HP、状態異常、場のポケモン）は入力の値で上書きする。
// - 相手のHPは割合（%）で持ち、仮の盤面を作るときに、その型の最大HPで実数に直す。
import { makeRunner } from '../engine/runner.ts';
import type { Position, PosMon, PosSide, MonSet, StatusID, Action } from '../engine/position.ts';
import { expandPrior, OpponentSet, clueItem, clueAbility, type PriorEntry, type SetCand } from '../infer/sets.ts';
void clueAbility;
import { makeCalc, shownPercent } from '../infer/calc.ts';
import { BenchModel } from '../infer/bench.ts';
import { mergePriors, type Learned } from '../learn/merge.ts';

const toID = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

export interface BattleSetup {
  ours: MonSet[];          // こちらの選出3匹（並びはこの順。番号はこの並び）
  ourLead: number;
  oppSpecies: string[];    // 相手の6匹（英語名。番号はこの並び）
  ourTeamJa: string[];     // こちらの6匹の日本語名（選出の出し分けの照合用）
}
/** 2つの行動が同じか（技の番号とメガシンカの有無、または交代先）。mega の印がないことと false は同じに扱う。 */
export const sameAction = (x: Action, y: Action) => x.kind === y.kind && (x.kind === 'switch' ? x.to === (y as any).to : x.slot === (y as any).slot && !!x.mega === !!(y as any).mega);
/** 結果の予想（predict の戻り値）。HP は乱数ごとの中央値、場のポケモン・状態異常はいちばん多いもの。 */
export interface Prediction {
  first: 'us' | 'them' | undefined; firstSure: number;
  ourHps: number[]; ourActive: number; ourStatus: string;
  oppActive: number; oppHpPct: number; oppStatus: string; oppHpRange: [number, number]; n: number;
  oppHps: Record<number, number>;
}
export type OppAction = { kind: 'move'; move: string; mega?: boolean } | { kind: 'switch'; to: number } | { kind: 'none' };
export type OurAction = Action | { kind: 'none' };
export interface TurnInput {
  ours: OurAction;
  opp: OppAction;
  first?: 'us' | 'them';           // 両方が技を出したとき、どちらが先だったか
  critOnOpp?: boolean;             // こちらの攻撃が急所だった（入れていなければ undefined＝分からない）
  critOnUs?: boolean;              // 相手の攻撃が急所だった（同上）
  oppItem?: string;                // 相手の持ち物の発動（英語名）
  oppAbility?: string;             // 相手の特性の発動（英語名）
  ourMega?: boolean;               // こちらがこのターンにメガシンカした（技を出せなくてもメガシンカは起きる）
  oppMega?: boolean;               // 相手がこのターンにメガシンカした
  // ourActive の HP が0なら、そのポケモンは倒れて交代先がまだ（死に出しの場面）。oppActive も同じ（相手の HP% が0で、両方倒れたとき）
  // oppHps：ターンの後の場のポケモン以外の相手のポケモンの HP%（6匹の番号 → %）。場から下がったポケモン（とんぼがえり・ドラゴンテール・倒れた等）の値
  after: { ourActive: number; ourHp: number; ourStatus: StatusID; oppActive: number; oppHpPct: number; oppStatus: StatusID; ourHps?: number[]; oppHps?: Record<number, number> };
  visible?: VisibleState;
}
/** 画面に見える状態（「今の状態」欄で確かめ・直したもの）。入っていれば、再現の値を上書きする。 */
export interface VisibleState {
  boosts?: [Partial<Record<string, number>>, Partial<Record<string, number>>];   // こちらの場のポケモン、相手の場のポケモン
  weather?: string; terrain?: string; trickroom?: boolean;                        // '' はなし
  cond?: [Record<string, number>, Record<string, number>];                        // まきびし等（層の数か、ある=1）
  vol?: [{ leechseed?: boolean; substitute?: boolean }, { leechseed?: boolean; substitute?: boolean }];  // 場のポケモンのやどりぎのタネ・みがわり
  ourItem?: string;   // こちらの場のポケモンが今持っている持ち物（id、'' はなし）。トリック等で変わったとき用
}
export interface StartInput { oppLead: number; oppAbility?: string; oppItem?: string }
/** 死に出し：倒れたポケモンに代わって出したポケモンと、出てきた後の HP（ステルスロック等の後）。ourTo はこちらの3匹の番号、oppTo は相手の6匹の番号。 */
export interface ReplaceInput { ourTo?: number; oppTo?: number; ourHps?: number[]; oppHpPct?: number; oppAbility?: string; oppItem?: string }

interface OppMonState { seen: boolean; hpPct: number; status: StatusID; fainted: boolean }

/** learned：対戦記録から数えた型の割合と選出の傾向（data/priors/learned.json）。あれば最初の確率に混ぜる。 */
export function makeAnalyzer(PS: any, FORMAT: string, basePriors: { species: Record<string, PriorEntry> }, teams: any[], selections: any[], learned?: Learned | null) {
  const priors = mergePriors(basePriors, learned);
  const Runner = makeRunner(PS, FORMAT);
  const dex = PS.Dex.forFormat(FORMAT);
  const calc = makeCalc(PS, FORMAT);
  const bench = new BenchModel(teams, selections, learned?.bench);
  const maxhpOf = (set: MonSet) => dex.species.get(set.species).baseStats.hp + set.evs.hp + 75;

  // 使った側のHPがそのターンのうちに動く技（回復・吸い取り・反動・やどりぎのタネ・みがわり等）
  const SELF_HP = new Set(['synthesis', 'moonlight', 'morningsun', 'shoreup', 'strengthsap', 'rest', 'painsplit', 'wish', 'leechseed', 'ingrain', 'aquaring',
    'substitute', 'bellydrum', 'filletaway', 'clangoroussoul', 'curse', 'steelbeam', 'mindblown', 'chloroblast', 'healingwish', 'lunardance', 'memento', 'finalgambit',
    'explosion', 'selfdestruct', 'mistyexplosion', 'highjumpkick', 'jumpkick', 'shedtail', 'junglehealing', 'lifedew', 'swallow', 'milkdrink', 'softboiled', 'recover', 'slackoff', 'roost']);
  const selfHpMove = (m: string) => { const mv = dex.moves.get(m); return !!(mv.drain || mv.recoil || mv.heal || mv.selfdestruct || mv.hasCrashDamage || mv.mindBlownRecoil || SELF_HP.has(mv.id)); };

  return class Analyzer {
    setup: BattleSetup;
    opp: OppMonState[];
    sets: OpponentSet[];               // 相手の6匹それぞれの型の推定
    benchDist: Map<string, number>;
    pos!: Position;                    // 今の盤面（相手の型は「いちばんありそうな型」で置いたもの）
    oppOrder: number[] = [];           // pos.sides[1].mons の各ポケモンが、相手の6匹の何番か
    turn = 0;
    notes: string[] = [];              // 直近のターンの再現についての注意
    itemChanged: boolean[] = [false, false, false, false, false, false]; // トリック等で持ち物が入れ替わったかもしれないポケモン
    itemGone: boolean[] = [false, false, false, false, false, false];    // 持ち物がなくなったのが画面で見えたポケモン（使い切りの持ち物の発動、はたきおとす）
    constructor(setup: BattleSetup) {
      this.setup = setup;
      this.opp = setup.oppSpecies.map(() => ({ seen: false, hpPct: 100, status: '', fainted: false }));
      this.sets = setup.oppSpecies.map(sp => new OpponentSet(expandPrior(priors.species[toID(sp)] ?? priors.species[toID(dex.species.get(sp).baseSpecies)])));
      this.benchDist = bench.prior(setup.oppSpecies, setup.ourTeamJa);
    }

    /** 相手のポケモン i の、今いちばんありそうな型（見えた技を必ず含める）。 */
    mapSet(i: number, mustMove?: string, extra?: (c: SetCand) => number): MonSet {
      const s = this.sets[i];
      let post = s.posterior() ?? s.cands.map(c => c.prior);
      // extra：今のターンだけの手がかり（予想で決めた行動順など）。全部の候補が0になるときは使わない
      if (extra) { const w = post.map((p, k) => p * extra(s.cands[k])); if (w.some(x => x > 0)) post = w; }
      let best = 0; post.forEach((p, k) => { if (p > post[best]) best = k; });
      const c = s.cands[best];
      let moves = c.generic ? [...s.moves] : [...c.moves];
      if (c.generic) { const probs = [...s.moveProbabilities().keys()]; for (const m of probs) if (moves.length < 4 && !moves.includes(m)) moves.push(m); }
      for (const m of [...s.moves, ...(mustMove ? [mustMove] : [])]) if (!moves.some(x => toID(x) === toID(m))) { if (moves.length >= 4) moves.pop(); moves.unshift(m); }
      return { species: this.setup.oppSpecies[i], item: toID(c.item), ability: toID(c.ability), nature: c.nature, evs: c.evs, moves: moves.slice(0, 4).map(toID) };
    }

    /** 相手の選出の3匹（見えたポケモン＋ありそうなポケモン）。 */
    oppTrio(): number[] {
      const seen = this.opp.map((o, i) => o.seen ? i : -1).filter(i => i >= 0);
      const inc = BenchModel.inclusion(this.benchDist, seen);
      const rest = [0, 1, 2, 3, 4, 5].filter(i => !seen.includes(i)).sort((a, b) => inc[b] - inc[a]);
      return [...seen, ...rest].slice(0, 3);
    }

    /** 対戦の始まり：先発を出した直後の盤面を作る（特性の効果も入る）。 */
    /** 相手のポケモン i の種族（とそのメガシンカ）が持てる特性。 */
    possibleAbilities(i: number): Set<string> {
      const owner = dex.species.get(this.setup.oppSpecies[i]);
      const out = new Set<string>([...Object.values(owner.abilities).map((a: any) => toID(a))]);
      for (const it of dex.items.all()) if (it.megaStone) for (const [from, f] of Object.entries(it.megaStone) as [string, string][]) if (dex.species.get(from).baseSpecies === owner.baseSpecies) out.add(toID(dex.species.get(f).abilities['0']));
      return out;
    }

    start(s: StartInput) {
      this.opp[s.oppLead].seen = true;
      // その種族（とメガシンカ）が持てない特性は、トレース等で写したものなので、手がかりにしない（record と同じ）
      if (s.oppAbility && this.possibleAbilities(s.oppLead).has(toID(s.oppAbility))) this.sets[s.oppLead].add(clueAbility(s.oppAbility));
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

    /** pos の相手側を、今の推定（いちばんありそうな型）と見えている HP% で作り直す。order は相手の6匹の番号。 */
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
      // 交代先が新しく見えたポケモンなら、相手の3匹に入れる
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
      // そのポケモンについては、以後、持ち物・順番・ダメージの手がかりを使わない
      const SWAP = ['trick', 'switcheroo', 'thief', 'covet', 'bestow'];
      const ourMoveId = t.ours.kind === 'move' ? start.sides[0].mons[start.sides[0].active].set.moves[t.ours.slot] : '';
      const swapNow = (oppMove && SWAP.includes(toID(oppMove))) || SWAP.includes(toID(ourMoveId ?? ''));
      const itemFrozen = this.itemChanged[oppActiveIdx] || swapNow;
      if (swapNow) this.itemChanged[oppActiveIdx] = true;
      if (t.oppItem && !this.itemChanged[t.after.oppActive] && !(t.after.oppActive === oppActiveIdx && itemFrozen)) this.sets[t.after.oppActive].add(clueItem(t.oppItem));
      // 使い切りの持ち物の発動が見えたら、そのポケモンの持ち物はなくなった
      if (t.oppItem) {
        const it = dex.items.get(t.oppItem);
        if (it.isBerry || ['focussash', 'airballoon', 'whiteherb', 'mentalherb', 'powerherb', 'redcard', 'ejectbutton', 'ejectpack', 'weaknesspolicy', 'boosterenergy', 'roomservice', 'throatspray', 'adrenalineorb', 'blunderpolicy', 'mirrorherb', 'cellbattery', 'absorbbulb', 'snowball', 'luminousmoss'].includes(it.id)) this.itemGone[t.after.oppActive] = true;
      }
      const possibleAb = this.possibleAbilities(t.after.oppActive);
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
        // 選べる行動の中から、入力と同じ行動（技の番号・メガシンカの有無、または交代先）を探す。
        // 形で比べる（文字列で比べると、画面の入力の「mega: false」の印があるだけで一致しなくなり、いつも1番目の技で作り直していた）
        const a0 = ours ? legal0.find(x => sameAction(x, ours)) ?? legal0[0] ?? null : (legal0[0] ?? null);
        const want1 = oppAct(r);
        const a1 = want1 ? legal1.find(x => sameAction(x, want1)) ?? legal1.find(x => x.kind === 'move' && want1.kind === 'move' && x.slot === want1.slot) ?? legal1[0] ?? null : (legal1[0] ?? null);
        try { r.play(a0, a1, 6, [t.after.ourActive, order.indexOf(t.after.oppActive)]); } catch { continue; }
        const log: string[] = r.battle.log;
        const p = r.toPosition();
        const score = this.mismatch(t, p, log, order);
        if (!best || score < best.score) best = { score, pos: p, log };
        if (score === 0) break;
      }
      if (!best) { this.notes.push('このターンを Showdown で再現できませんでした。盤面は入力の値だけで作ります。'); best = { score: 99, pos: replayPos, log: [] }; }
      // HP の少しの違いは、相手の型を推定で置いているので起きる。場のポケモン・状態異常・順番・急所が合わないときだけ知らせる
      if (best.score >= 1) this.notes.push(`入力と合う再現が見つかりませんでした（ずれの点数 ${best.score.toFixed(2)}）。能力ランクや場の状態を確かめてください。`);
      // 見えた値で上書き
      const pos = best.pos;
      const us = pos.sides[0];
      us.active = t.after.ourActive;
      if (t.after.ourHps) t.after.ourHps.forEach((hp, k) => { us.mons[k].hp = hp; if (hp <= 0) us.mons[k].status = ''; });
      const ua = us.mons[us.active]; ua.hp = t.after.ourHp; ua.status = t.after.ourStatus;
      const oa = this.opp[t.after.oppActive];
      oa.hpPct = t.after.oppHpPct; oa.status = t.after.oppStatus; oa.fainted = t.after.oppHpPct <= 0;
      // 相手が倒れたポケモン
      // 再現で倒れたことにするのは、そのターンに場にいたポケモン（ターンの始めの場・交代先）だけ。控えにいたポケモンは、このターンに倒れない
      const onFieldThisTurn = new Set([oppActiveIdx, ...(t.opp.kind === 'switch' ? [t.opp.to] : [])]);
      for (const [k, i] of order.entries()) if (pos.sides[1].mons[k].hp <= 0 && i !== t.after.oppActive && onFieldThisTurn.has(i)) { this.opp[i].fainted = true; this.opp[i].hpPct = 0; }
      // 死に出しの場面では、再現が交代先を勝手に選んで出している（ステルスロック等を受けている）ので、ほかのポケモンの HP は再現から取らない
      const pendingSwitch = t.after.ourHp <= 0 || t.after.oppHpPct <= 0;
      // 控えにいたポケモンの HP は変わらないので、取り直すのはターンの始めに場にいたポケモンだけ（%→実数→% の行き来で1ずつ減っていくのを防ぐ）
      // 入力にないポケモンは、入力から見てそのターンに場にいたポケモン（ターンの始めの場のポケモン・交代先）で、再現で HP が動いたときだけ再現の値を使う
      // （再現が本当と違う展開を選ぶと、場に出ていないポケモンの HP が動くことがあるため）
      const onFieldIdx = new Set<number>([oppActiveIdx, ...(t.opp.kind === 'switch' ? [t.opp.to] : [])]);
      if (!pendingSwitch) for (const [k, i] of order.entries()) {
        if (i === t.after.oppActive || this.opp[i].fainted || !this.opp[i].seen || !onFieldIdx.has(i) || t.after.oppHps?.[i] !== undefined) continue;
        const before = replayPos.sides[1].mons[k], after = pos.sides[1].mons[k];
        if (before && after && before.hp !== after.hp) this.opp[i].hpPct = shownPercent(after.hp, maxhpOf(after.set));
      }
      // 画面で見えた相手のポケモンごとの HP%（場から下がったポケモンの値）
      for (const [is, pct] of Object.entries(t.after.oppHps ?? {})) { const i = Number(is); if (i === t.after.oppActive) continue; this.opp[i].seen = true; this.opp[i].hpPct = pct; this.opp[i].fainted = pct <= 0; const k = order.indexOf(i); if (k >= 0) { const m = pos.sides[1].mons[k]; m.hp = pct <= 0 ? 0 : Math.max(1, Math.round(maxhpOf(m.set) * pct / 100)); if (pct <= 0) m.status = ''; } }
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
          os.add(calc.clueDamageToOpp(clueStart, 0, this.setup.oppSpecies[oppActiveIdx], mv.name, before, t.after.oppHpPct, t.critOnOpp));
        }
      }
      if (this.knockedPending !== null) { this.itemGone[this.knockedPending] = true; this.knockedPending = null; }
      return { notes: this.notes, score: best.score };
    }
    knockedPending: number | null = null;

    /**
     * このターンの結果の予想（入力の欄に先に入れるため）。記録係の今の盤面から、相手の型を「いちばんありそうな型」にして、
     * 両者の行動で seeds 通りの乱数で打ち、HP は真ん中の値、場のポケモン・状態異常・先に動いた側はいちばん多いものを返す。
     * 反動・さめはだ・ゴツゴツメット・ステルスロック・いのちのたま・たべのこし等は Showdown が計算する。推定の状態は変えない。
     */
    /**
     * 結果の予想。how：画面で決めた（または直した）条件。
     *  - ourTo / oppTo：ターンの後の場のポケモン（こちらは盤面の並び、相手は6匹の番号）。交代技（ボルトチェンジ・とんぼがえり等）や
     *    ドラゴンテール等でターンの途中に入れ替わるとき、そのポケモンを出す（決めなければ番号の若いポケモン）
     *  - first：先に動いた側。決めたときは、その順になった乱数だけを使う（交代技を先に打てば、相手の攻撃は出てきたポケモンが受ける）
     */
    predict(t: { ours: TurnInput['ours']; opp: TurnInput['opp'] }, seeds = 24, how: { ourTo?: number; oppTo?: number; first?: 'us' | 'them'; anyMove?: boolean } = {}): Prediction | null {
      const start = this.pos;
      const oppActiveIdx = this.oppOrder[start.sides[1].active];
      const oppMove = t.opp.kind === 'move' ? t.opp.move : undefined;
      const sw = t.opp.kind === 'switch' ? t.opp.to : -1;
      const to = how.oppTo !== undefined && how.oppTo !== oppActiveIdx && how.oppTo !== sw && !this.opp[how.oppTo]?.fainted ? how.oppTo : -1;
      const order = [oppActiveIdx, ...(sw >= 0 ? [sw] : []), ...(to >= 0 ? [to] : []), ...this.oppTrio().filter(i => i !== oppActiveIdx && i !== sw && i !== to)].slice(0, 3);
      // まだ見えていないポケモンへ交代するときも、そのポケモンの盤面を作れるように一時的に見えたことにする（終わったら戻す）
      const tmpSeen = [sw, to].filter(i => i >= 0 && !this.opp[i].seen);
      for (const i of tmpSeen) this.opp[i].seen = true;
      try {
        // 先に動いた側を決めたときは、場の相手の型を、その順になる型の中からいちばんありそうなものにする（記録の手がかりと同じ計算）
        let orderLike: ((c: SetCand) => number) | undefined;
        if (how.first && t.ours.kind === 'move' && oppMove) {
          const ourMove = start.sides[0].mons[start.sides[0].active].set.moves[t.ours.slot];
          if (ourMove) {
            const base: Position = { ...start, sides: [start.sides[0], this.oppSide(order, start, i => this.mapSet(i, i === oppActiveIdx ? oppMove : undefined))] };
            const cp: Position = JSON.parse(JSON.stringify(base));
            if (t.opp.kind === 'move' && t.opp.mega) { const s1 = cp.sides[1]; s1.mons[s1.active].mega = true; s1.megaUsed = true; }
            if (t.ours.mega) { const s0 = cp.sides[0]; s0.mons[s0.active].mega = true; s0.megaUsed = true; }
            const clue = calc.clueOrder(cp, 0, this.setup.oppSpecies[oppActiveIdx], ourMove, oppMove, how.first === 'them');
            orderLike = c => clue.like(c);
          }
        }
        const pos: Position = { ...start, sides: [start.sides[0], this.oppSide(order, start, i => this.mapSet(i, i === oppActiveIdx ? oppMove : undefined, i === oppActiveIdx ? orderLike : undefined))] };
        const firsts: string[] = [], ourActs: number[] = [], oppActs: number[] = [], ourSt: string[] = [], oppSt: string[] = [];
        const ourHps: number[][] = start.sides[0].mons.map(() => []), oppPcts: number[] = [];
        const oppPctsBy = new Map<number, number[]>();   // 相手の6匹の番号 → 各乱数での HP%
        for (let seed = 1; seed <= seeds; seed++) {
          let r;
          try { r = new Runner(pos, seed); } catch { break; }
          const legal0 = r.legalActions(0), legal1 = r.legalActions(1);
          const same = (x: any, y: any) => x.kind === y.kind && (x.kind === 'switch' ? x.to === y.to : x.slot === y.slot && !!x.mega === !!y.mega);
          // 「動けなかった」（ねむり・ひるみ・先に倒された等）や、選べない行動のときは、記録と同じく選べる行動の最初を渡す
          // （何も渡さないと Showdown がその側の選択を待ち、ターンが進まない＝何も起きない予想になる）
          const a0 = (t.ours.kind === 'none' ? null : legal0.find((x: any) => same(x, t.ours))) ?? legal0[0] ?? null;
          let a1: Action | null = null;
          if (t.opp.kind === 'switch') a1 = legal1.find((x: any) => x.kind === 'switch' && x.to === order.indexOf(sw)) ?? null;
          else if (t.opp.kind === 'move') {
            const set = pos.sides[1].mons[pos.sides[1].active].set;
            const k = set.moves.findIndex(m => toID(m) === toID((t.opp as any).move));
            a1 = legal1.find((x: any) => x.kind === 'move' && x.slot === Math.max(0, k) && !!x.mega === !!(t.opp as any).mega) ?? legal1.find((x: any) => x.kind === 'move' && x.slot === Math.max(0, k)) ?? null;
          }
          a1 ??= legal1[0] ?? null;
          const prefer: [number | null, number | null] = [how.ourTo ?? null, how.oppTo !== undefined && order.includes(how.oppTo) ? order.indexOf(how.oppTo) : null];
          // ターンの途中の交代（交代技・ドラゴンテール・相手が倒れた後）は決めた交代先を出す。こちらが倒れた後の交代は、
          // 死に出しの画面で選ぶので出さない（出すと、出てきたポケモンにステルスロック等のダメージが入った予想になる）
          try {
            r.play(a0, a1, 0);
            const b = r.battle;
            for (let step = 0; step < 6 && !b.ended && b.requestState === 'switch'; step++) {
              let chose = false;
              for (const si of [0, 1] as const) {
                const side = b.sides[si];
                if (!side.activeRequest || side.activeRequest.wait || !side.activeRequest.forceSwitch) continue;
                if (si === 0 && side.active[0]?.fainted) continue;
                const opts = r.legalActions(si).filter((x: Action) => x.kind === 'switch') as { kind: 'switch'; to: number }[];
                opts.sort((x, y) => (x.to === prefer[si] ? -1 : 0) - (y.to === prefer[si] ? -1 : 0) || x.to - y.to);
                b.choose(side.id, opts.length ? r.choiceString(si, opts[0]) : 'pass'); chose = true;
              }
              if (!chose) break;
            }
          } catch { continue; }
          const log: string[] = r.battle.log;
          const f = log.find(l => /^\|move\|p[12]a:/.test(l) && !l.includes('[from]'));
          const fs = f ? (f.startsWith('|move|p2a') ? 'them' : 'us') : undefined;
          if (fs) firsts.push(fs);
          // 先に動いた側を決めたときは、その順の乱数だけを使う（両方が技を出した乱数で、順が違うものは除く）
          if (how.first && fs && log.filter(l => /^\|move\|p[12]a:/.test(l) && !l.includes('[from]')).length >= 2 && fs !== how.first) continue;
          // 「動けなかった」側が技を出した乱数は使わない（代わりに渡した技が出ると、本当は起きないダメージや反動が入る）
          if (!how.anyMove && ((t.ours.kind === 'none' && log.some(l => l.startsWith('|move|p1a') && !l.includes('[from]'))) || (t.opp.kind === 'none' && log.some(l => l.startsWith('|move|p2a') && !l.includes('[from]'))))) continue;
          const p = r.toPosition();
          ourActs.push(p.sides[0].active); oppActs.push(order[p.sides[1].active]);
          p.sides[0].mons.forEach((m, k) => ourHps[k].push(m.hp));
          ourSt.push(p.sides[0].mons[p.sides[0].active].status || '');
          const om = p.sides[1].mons[p.sides[1].active];
          oppPcts.push(shownPercent(om.hp, maxhpOf(om.set))); oppSt.push(om.status || '');
          p.sides[1].mons.forEach((m, k) => { const i = order[k]; if (!oppPctsBy.has(i)) oppPctsBy.set(i, []); oppPctsBy.get(i)!.push(shownPercent(m.hp, maxhpOf(m.set))); });
        }
        // 決めた順になる乱数がひとつもなかった（仮に決めた相手の型では、その順にならない）ときは、順を決めずに予想する
        if (!oppPcts.length && how.first) return this.predict(t, seeds, { ...how, first: undefined });
        // 動けなかった側が、どの乱数でも技を出した（ねむりが覚める等）ときは、その条件を外して予想する
        if (!oppPcts.length && !how.anyMove && (t.ours.kind === 'none' || t.opp.kind === 'none')) return this.predict(t, seeds, { ...how, anyMove: true });
        if (!oppPcts.length) return null;
        const median = (xs: number[]) => { const v = [...xs].sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
        const mode = <T,>(xs: T[]): T => { const c = new Map<T, number>(); for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1); return [...c].sort((a, b) => b[1] - a[1])[0][0]; };
        const firstUs = firsts.filter(x => x === 'us').length;
        return {
          first: firsts.length ? (firstUs * 2 >= firsts.length ? 'us' : 'them') as 'us' | 'them' : undefined,
          firstSure: firsts.length ? Math.max(firstUs, firsts.length - firstUs) / firsts.length : 0,
          ourHps: ourHps.map(median), ourActive: mode(ourActs), ourStatus: mode(ourSt), oppActive: mode(oppActs), oppHpPct: median(oppPcts), oppStatus: mode(oppSt),
          oppHpRange: [Math.min(...oppPcts), Math.max(...oppPcts)] as [number, number], n: oppPcts.length,
          oppHps: Object.fromEntries([...oppPctsBy].map(([i, xs]) => [i, median(xs)])) as Record<number, number>,
        };
      } finally {
        for (const i of tmpSeen) this.opp[i].seen = false;
      }
    }

    /** 死に出しの場面か：倒れた場のポケモンがあり、控えが残っている側（0 こちら、1 相手）。 */
    pendingSides(): (0 | 1)[] {
      const out: (0 | 1)[] = [];
      const us = this.pos.sides[0];
      // 決着していれば（こちらが全員倒れた、または相手が3匹倒れた）死に出しはない
      if (!us.mons.some(m => m.hp > 0) || this.opp.filter(o => o.fainted).length >= 3) return out;
      if (us.mons[us.active].hp <= 0 && us.mons.some(m => m.hp > 0)) out.push(0);
      const oi = this.oppOrder[this.pos.sides[1].active];
      const fainted = this.opp.filter(o => o.fainted).length;
      if (this.opp[oi]?.fainted && fainted < 3) out.push(1);
      return out;
    }

    /**
     * 死に出しを記録する（dryRun なら、出てきた後の HP の予想だけを返し、推定の状態は変えない）。
     * 交代先を Showdown で出して（ステルスロック・いかく等が起きる）、画面の HP で上書きする。
     */
    replace(r: ReplaceInput, dryRun = false) {
      const start = this.pos;
      const oppActiveIdx = this.oppOrder[start.sides[1].active];
      const seenBefore = r.oppTo !== undefined ? this.opp[r.oppTo].seen : true;
      if (r.oppTo !== undefined) this.opp[r.oppTo].seen = true;
      const order = [oppActiveIdx, ...(r.oppTo !== undefined ? [r.oppTo] : []), ...this.oppTrio().filter(i => i !== oppActiveIdx && i !== r.oppTo)].slice(0, 3);
      try {
        const pos: Position = { ...start, sides: [start.sides[0], this.oppSide(order, start, i => this.mapSet(i))] };
        // 盤面の状態（まきびし類・天気・能力ランク・こだわりの固定等）を当てた対戦で交代させる。倒れた場のポケモンは交代先を選ぶ要求になる
        // （前は状態を当てない対戦で交代させていたので、死に出しの後に、まきびし類・天気・能力ランク等が消えていた）
        const run = new Runner(pos, 1);
        const a0: Action | null = r.ourTo !== undefined ? { kind: 'switch', to: r.ourTo } : null;
        const a1: Action | null = r.oppTo !== undefined ? { kind: 'switch', to: order.indexOf(r.oppTo) } : null;
        const legal0 = run.legalActions(0), legal1 = run.legalActions(1);
        run.play(a0 && legal0.some((x: any) => x.kind === 'switch' && x.to === (a0 as any).to) ? a0 : null, a1 && legal1.some((x: any) => x.kind === 'switch' && x.to === (a1 as any).to) ? a1 : null);
        const p = run.toPosition();
        if (r.ourTo !== undefined) p.sides[0].active = r.ourTo;
        if (r.oppTo !== undefined) p.sides[1].active = order.indexOf(r.oppTo);
        const om = p.sides[1].mons[p.sides[1].active];
        const pred = { ourHps: p.sides[0].mons.map(m => m.hp), oppHpPct: shownPercent(om.hp, maxhpOf(om.set)) };
        if (dryRun) return pred;
        // 画面の値で上書き
        if (r.ourHps) r.ourHps.forEach((hp, k) => { p.sides[0].mons[k].hp = hp; if (hp <= 0) p.sides[0].mons[k].status = ''; });
        if (r.oppTo !== undefined) {
          const pct = r.oppHpPct ?? pred.oppHpPct;
          this.opp[r.oppTo].hpPct = pct; this.opp[r.oppTo].fainted = pct <= 0;
          om.hp = pct <= 0 ? 0 : Math.max(1, Math.round(maxhpOf(om.set) * pct / 100));
          if (r.oppAbility) this.sets[r.oppTo].add(clueAbility(r.oppAbility));
          if (r.oppItem) this.sets[r.oppTo].add(clueItem(r.oppItem));
        }
        this.oppOrder = order;
        this.pos = p;
        return pred;
      } finally {
        if (dryRun && r.oppTo !== undefined) this.opp[r.oppTo].seen = seenBefore;
      }
    }

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
      // 倒れて交代先がまだの側は、再現が交代先を出しているので場のポケモンを比べない（倒れたことは HP で比べる）
      if (t.after.ourHp > 0 && us.active !== t.after.ourActive) s += 3;
      if (t.after.oppHpPct > 0 && order[them.active] !== t.after.oppActive) s += 3;
      const ua = us.mons[t.after.ourActive];
      s += Math.abs(ua.hp - t.after.ourHp) / maxhpOf(ua.set);
      // 倒れたかどうかが入力と違う再現（HP の差は小さくても、倒れると能力ランク等が消えるので、別の展開）
      if ((ua.hp <= 0) !== (t.after.ourHp <= 0)) s += 3;
      if ((ua.status || '') !== t.after.ourStatus) s += 1;
      const k = order.indexOf(t.after.oppActive);
      if (k >= 0) {
        const om = them.mons[k];
        s += Math.abs(shownPercent(om.hp, maxhpOf(om.set)) - t.after.oppHpPct) / 100;
        if ((om.hp <= 0) !== (t.after.oppHpPct <= 0)) s += 3;
        if ((om.status || '') !== t.after.oppStatus) s += 1;
      }
      if (t.first) {
        const f = log.find(l => /^\|move\|p[12]a:/.test(l) && !l.includes('[from]'));
        if (f && (f.startsWith('|move|p2a') ? 'them' : 'us') !== t.first) s += 2;
      }
      // 「動けなかった」側が技を出した再現（ねむりが覚めた等）は、本当と違う
      const moved = (pre: string) => log.some(l => l.startsWith(`|move|${pre}`) && !l.includes('[from]'));
      if (t.ours.kind === 'none' && moved('p1a')) s += 2;
      if (t.opp.kind === 'none' && moved('p2a')) s += 2;
      // 入力では倒れていない相手のポケモンが、再現で倒れている（場のポケモン以外）
      for (const [kk, i] of order.entries()) {
        if (i === t.after.oppActive || them.mons[kk].hp > 0 || this.opp[i].fainted) continue;
        if (t.after.oppHps?.[i] !== undefined && t.after.oppHps[i] <= 0) continue;
        s += 3;
      }
      const critOnOpp = log.some(l => l.startsWith('|-crit|p2a')), critOnUs = log.some(l => l.startsWith('|-crit|p1a'));
      // 急所を入れていない（undefined）ときは比べない
      if (t.critOnOpp !== undefined && t.critOnOpp !== critOnOpp) s += 1;
      if (t.critOnUs !== undefined && t.critOnUs !== critOnUs) s += 1;
      return s;
    }

    /** 探索用の仮の盤面を k 個作る（相手の控えと型を、今の推定から抜き出す）。 */
    determinizations(k: number, rand: () => number): Position[] {
      const out: Position[] = [];
      const seen = this.opp.map((o, i) => o.seen ? i : -1).filter(i => i >= 0);
      const activeIdx = this.oppOrder[this.pos.sides[1].active];
      for (let n = 0; n < k; n++) {
        // 控え：見えたポケモンを含む3匹の組を、選出の推定から抜き出す
        let trio: number[] = [];
        const cands = [...this.benchDist.entries()].filter(([key]) => seen.every(i => key.split(',').map(Number).includes(i)));
        const total = cands.reduce((a, [, v]) => a + v, 0);
        let r = rand() * total;
        for (const [key, v] of cands) { r -= v; if (r <= 0) { trio = key.split(',').map(Number); break; } }
        if (trio.length !== 3) trio = this.oppTrio();
        const order = [activeIdx, ...trio.filter(i => i !== activeIdx)].slice(0, 3);
        const side = this.oppSide(order, this.pos, i => {
          // メガシンカ済みのポケモンは、メガストーンを持つ型だけにする（持たない型が抜き出されたら、いちばんありそうな型にする）
          const m = this.pos.sides[1].mons[this.oppOrder.indexOf(i)];
          let s = this.sets[i].sample(rand);
          if (s && m?.mega && !dex.items.get(s.item).megaStone) s = null;
          return s ? { species: this.setup.oppSpecies[i], item: toID(s.item), ability: toID(s.ability), nature: s.nature, evs: s.evs, moves: s.moves.map(toID) } : this.mapSet(i);
        });
        out.push({ ...this.pos, sides: [this.pos.sides[0], side] });
      }
      return out;
    }

    /** 相手のポケモン i の推定のまとめ（上位の持ち物・特性・技）。 */
    summary(i: number) {
      const s = this.sets[i];
      const top = (m: Map<string, number>, n: number) => [...m.entries()].slice(0, n).map(([k, v]) => ({ name: k, p: v }));
      return { items: top(s.marginal(c => c.item), 4), abilities: top(s.marginal(c => c.ability), 3), moves: top(s.moveProbabilities(), 8), revealed: [...s.moves], ok: !!s.posterior() };
    }

    /** こちらの選び方の文字列（探索の結果）を、表示用の行動にする。仮の盤面の並び：場のポケモン、残り（番号順）。 */
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
