// 対戦記録（data/logs/*.json）から、相手の型の割合と選出の傾向を数え、data/priors/learned.json に書く。
// 記録1件＝上位構築1件分。毎回、全部の記録から数え直す（記録を消したり直したりしても合うように）。
// 使い方：npx tsx tools/learn/learn-logs.ts [--logs 記録のフォルダ] [--out 書き出すファイル]
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
const files = existsSync(LOGS) ? readdirSync(LOGS).filter(f => f.endsWith('.json')).sort() : [];
let ok = 0;
for (const f of files) {
  try {
    const doc = JSON.parse(readFileSync(`${LOGS}/${f}`, 'utf8'));
    const an = new Analyzer(doc.setup);
    an.start(doc.start);
    if (doc.startVisible) an.applyVisible(an.pos, doc.startVisible);
    for (const step of doc.turns ?? []) { an.record(step.input); if (step.visible) an.applyVisible(an.pos, step.visible); }
    addAnalyzer(learned, an, teams, dex, priors);
    learned.logs.push(doc.id ?? f.replace(/\.json$/, ''));
    ok++;
  } catch (e: any) {
    console.log(`数えられなかった記録：${f}：${e.message}`);
  }
}
learned.updatedAt = new Date().toISOString();
writeFileSync(OUT, JSON.stringify(learned));
console.log(`記録 ${files.length} 件のうち ${ok} 件を数えた。種族 ${Object.keys(learned.sets).length}、書き出し先 ${OUT}`);
