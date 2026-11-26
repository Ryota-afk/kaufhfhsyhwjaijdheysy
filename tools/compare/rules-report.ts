// rules.ts の ref と fast の結果を合わせて、docs/rules-check.md を書く。
import { readFileSync, writeFileSync } from 'node:fs';
import { showdownCommit, FORMAT } from '../showdown/load.ts';
const ref = JSON.parse(readFileSync('.build/rules-ref.json', 'utf8'));
const fast = JSON.parse(readFileSync('.build/rules-fast.json', 'utf8'));
const L: string[] = ['# 指示文 4-1. の項目の個別の確かめ', ''];
L.push(`- 実行日：${new Date().toISOString().slice(0, 10)}`);
L.push(`- 基準：Pokémon Showdown コミット ${showdownCommit()}、形式 ${FORMAT}`);
L.push('- 「Showdown」は速さの層なし（記録も読んで処理の順番を確かめる）。「エンジン」は速さの層あり・複製してから打ったもの（記録は作らないので状態だけを見る）。');
L.push('- 「エンジンが Showdown と同じ」は、同じ盤面・同じ乱数の種で打った結果（状態）が、すべての回で完全に一致したかどうか。', '');
L.push('| 項目 | 決まり | Showdown で決まりどおり | エンジンが Showdown と同じ |', '|---|---|---|---|');
for (const r of ref) {
  const f = fast.find((x: any) => x.id === r.id);
  const same = f && JSON.stringify(f.fingerprint) === JSON.stringify(r.fingerprint);
  L.push(`| ${r.title} | ${r.rule} | ${r.pass === null ? '－' : r.pass ? '合格' : '**不合格**'} | ${same ? `同じ（${r.fingerprint.length}回）` : '**違う**'} |`);
}
L.push('', '## 測った値', '');
for (const r of ref) {
  L.push(`### ${r.title}`, '');
  for (const [k, v] of Object.entries(r.measured)) {
    if (Array.isArray(v)) { L.push(`- ${k}：`); for (const x of v) L.push(`  - ${x}`); } else L.push(`- ${k}：${v}`);
  }
  if (r.note) L.push(`- 補足：${r.note}`);
  L.push('');
}
writeFileSync('docs/rules-check.md', L.join('\n'));
console.log(L.slice(0, 20).join('\n'));
const bad = ref.filter((r: any) => r.pass === false || JSON.stringify(fast.find((x: any) => x.id === r.id)?.fingerprint) !== JSON.stringify(r.fingerprint));
if (bad.length) { console.error('不合格：' + bad.map((r: any) => r.id).join(', ')); process.exitCode = 1; }
