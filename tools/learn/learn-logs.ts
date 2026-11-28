// 対戦記録（data/logs/*.json）から、相手の型の割合と選出の傾向を数え、data/priors/learned.json に書く。
// 記録1件＝上位構築1件分。毎回、全部の記録から数え直す（記録を消したり直したりしても合うように）。
// 使い方：npx tsx tools/learn/learn-logs.ts [--logs 記録のフォルダ] [--out 書き出すファイル] [--excluded 外す記録の一覧]
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { loadShowdown, FORMAT } from '../showdown/load.ts';
import { makeAnalyzer } from '../../src/battle/analyze.ts';
import { addAnalyzer, emptyLearned } from '../../src/learn/count.ts';

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : d; };
const LOGS = arg('logs', 'data/logs'), OUT = arg('out', 'data/priors/learned.json');
const PS = loadShowdown();
const dex = PS.Dex.forFormat(FORMAT);
const priors = JSON.parse(readFileSync('data/priors/sets.json', 'utf8'));
const teams = JSON.parse(readFileSync('data/seed/teams_m7.json', 'utf8'));
const selections = JSON.parse(readFileSync('data/seed/selections_m7.json', 'utf8'));
// 数えるときの推定は、上位構築のデータだけの最初の確率で行う
const Analyzer = makeAnalyzer(PS, FORMAT, priors, teams, selections, null);

const learned = emptyLearned();
// 学習から外す記録（data/learn/excluded-logs.json。ファイルは消さずに残す）
const EXCLUDED = arg('excluded', 'data/learn/excluded-logs.json');
const excluded = new Set<string>((existsSync(EXCLUDED) ? JSON.parse(readFileSync(EXCLUDED, 'utf8')) : []).map((x: any) => x.id));
const files = (existsSync(LOGS) ? readdirSync(LOGS).filter(f => f.endsWith('.json')).sort() : [])
  .filter(f => { const out = excluded.has(f.replace(/\.json$/, '')); if (out) console.log(`学習から外す記録：${f}`); return !out; });
let ok = 0;
for (const f of files) {
  try {
    const doc = JSON.parse(readFileSync(`${LOGS}/${f}`, 'utf8'));
    const an = new Analyzer(doc.setup);
    an.start(doc.start);
    if (doc.startVisible) an.applyVisible(an.pos, doc.startVisible);
    // 死に出しの記録（replace）は、交代として当て直す（画面の当て直しと同じ。src/engine/browser/analysis-worker.ts）
    for (const step of doc.turns ?? []) { if (step.replace) an.replace(step.replace); else an.record(step.input); if (step.visible) an.applyVisible(an.pos, step.visible); }
    addAnalyzer(learned, an, teams, dex, priors);
    learned.logs.push(doc.id ?? f.replace(/\.json$/, ''));
    ok++;
  } catch (e: any) {
    console.log(`数えられなかった記録：${f}：${e.message}`);
  }
}
// 中身が前と同じなら書かない（毎日、日付だけ違うファイルを保存しないため）
const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null;
const body = (x: any) => JSON.stringify({ ...x, updatedAt: '' });
if (prev && body(prev) === body(learned)) { console.log('数えた結果は前と同じなので、書き直さない'); process.exit(0); }
learned.updatedAt = new Date().toISOString();
writeFileSync(OUT, JSON.stringify(learned));
console.log(`記録 ${files.length} 件のうち ${ok} 件を数えた。種族 ${Object.keys(learned.sets).length}、書き出し先 ${OUT}`);
