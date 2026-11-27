// 対戦の記録係の Worker：記録の出る Showdown（速さの層なし）で、入力したターンの再現・推定・仮の盤面づくりをする。
import { PS } from '@showdown';
import { makeAnalyzer, type Analyzer } from '../../battle/analyze.ts';

const FORMAT = 'gen9championsbssregmc';
let AnalyzerClass: ReturnType<typeof makeAnalyzer> | null = null;
let an: Analyzer | null = null;

function view() {
  if (!an) return null;
  const seen = an.opp.map((o, i) => o.seen ? i : -1).filter(i => i >= 0);
  return {
    pos: an.pos, opp: an.opp, oppOrder: an.oppOrder, turn: an.turn, notes: an.notes,
    summaries: Object.fromEntries(seen.map(i => [i, an!.summary(i)])),
  };
}

self.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data;
  try {
    if (msg.type === 'load') {
      const [priors, teams, selections] = await Promise.all([msg.priorsUrl, msg.teamsUrl, msg.selectionsUrl].map((u: string) => fetch(u).then(r => r.json())));
      // 対戦記録から数えた割合（まだ記録がなければ、ないまま）
      const learned = msg.learnedUrl ? await fetch(msg.learnedUrl, { cache: 'no-cache' }).then(r => r.ok ? r.json() : null).catch(() => null) : null;
      AnalyzerClass = makeAnalyzer(PS, FORMAT, priors, teams, selections, learned);
      (self as any).postMessage({ type: 'load' });
    } else if (msg.type === 'replay') {
      // 対戦の記録（準備・始まり・各ターン・状態の直し）を最初から当て直す
      an = new AnalyzerClass!(msg.battle.setup);
      an.start(msg.battle.start);
      // 最初のターンの前に「今の状態」で直したもの
      if (msg.battle.startVisible) an.applyVisible(an.pos, msg.battle.startVisible);
      for (const step of msg.battle.turns) {
        an.record(step.input);
        if (step.visible) an.applyVisible(an.pos, step.visible);
      }
      (self as any).postMessage({ type: 'view', view: view() });
    } else if (msg.type === 'record') {
      an!.record(msg.input);
      (self as any).postMessage({ type: 'view', view: view() });
    } else if (msg.type === 'edit') {
      an!.applyVisible(an!.pos, msg.visible);
      (self as any).postMessage({ type: 'view', view: view() });
    } else if (msg.type === 'dets') {
      let s = msg.seed >>> 0 || 1;
      const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
      (self as any).postMessage({ type: 'dets', positions: an!.determinizations(msg.k, rand) });
    }
  } catch (e: any) {
    (self as any).postMessage({ type: 'error', message: String(e?.stack ?? e) });
  }
};
