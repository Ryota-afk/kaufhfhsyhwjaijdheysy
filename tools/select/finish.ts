// 先回りの計算のまとめ：data/precomputed/ の表の一覧（index.json）と、パーティごとの相性の見積もり（<パーティ>/model.json）を作る。
// 4つの分担がそれぞれ表を保存した後に、1回だけ動かす（同じファイルを同時に書かないため）。
// 使い方：npx tsx tools/select/finish.ts [--root 保存先]
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fitPairModel, type TrainTable } from '../../src/select/model.ts';
import { partyKey } from '../../src/select/key.ts';

const argRoot = process.argv.indexOf('--root');
const root = argRoot >= 0 ? process.argv[argRoot + 1] : 'data/precomputed';
const index: any[] = [];
if (existsSync(root)) {
  for (const party of readdirSync(root)) {
    const dir = `${root}/${party}`;
    if (!statSync(dir).isDirectory()) continue;
    const train: TrainTable[] = [];
    // 今のパーティの中身で作った表だけで相性を見積もる（パーティを直す前の表は使わない）
    const pf = `data/parties/${party}.json`;
    const saved = readdirSync(dir).filter(f => /^(m\d+-)?\d+\.json$/.test(f)).map(f => ({ f, s: JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) }));
    // パーティのファイルがないとき（確かめ用）は、いちばん新しい表のパーティの目印を使う
    const latest = [...saved].sort((a, b) => String(b.s.updatedAt).localeCompare(String(a.s.updatedAt)))[0];
    const key = existsSync(pf) ? partyKey(JSON.parse(readFileSync(pf, 'utf8')).mons) : latest?.s.partyKey ?? null;
    for (const { f, s } of saved) {
      index.push({ party, partyKey: s.partyKey, rank: s.team.rank, season: s.team.season, species: s.team.species, level: s.level, done: s.done, games: s.games, value: s.solution?.value ?? null, file: `${party}/${f}` });
      if (s.games > 0 && s.partyKey === key) train.push({ species: s.team.species, stats: { n: s.n, w: s.w } });
    }
    const t0 = Date.now();
    const model = fitPairModel(train);
    writeFileSync(`${dir}/model.json`, JSON.stringify({ partyKey: key, ...model, W: round(model.W), V: round(model.V), b: Math.round(model.b * 1e4) / 1e4, fittedAt: new Date().toISOString() }));
    console.log(`${party}：表 ${train.length}、試合 ${model.games}、相性の見積もりを作った（${((Date.now() - t0) / 1000).toFixed(1)}秒）`);
  }
  writeFileSync(`${root}/index.json`, JSON.stringify({ updatedAt: new Date().toISOString(), tables: index.sort((a, b) => a.rank - b.rank) }));
}
console.log(`表の一覧：${index.length}件`);
function round(M: Record<string, number[]>) { const o: Record<string, number[]> = {}; for (const [k, v] of Object.entries(M)) o[k] = v.map(x => Math.round(x * 1e4) / 1e4); return o; }
