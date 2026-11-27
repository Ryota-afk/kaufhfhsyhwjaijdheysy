import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { calcStat, checkParty, STATS, type PartyMon } from '../src/party/model.ts';
import { putFile } from '../src/party/github.ts';

const dex = JSON.parse(readFileSync('src/engine/data/dex.json', 'utf8'));
const screen = JSON.parse(readFileSync('test/fixtures/party-team2-screen.json', 'utf8'));
const toID = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

test('実数値：利用者のゲーム画面（チーム2）の数字と一致する', () => {
  for (const m of screen) {
    const sp = dex.species[toID(m.species)];
    const n = dex.natures[m.nature];
    for (const s of STATS) assert.equal(calcStat(s, sp.baseStats[s], m.evs[s], n.plus, n.minus), m.shown[s], `${m.jp} ${s}`);
  }
});

test('検査：同じポケモン・同じ持ち物・能力ポイントの合計・覚えない技を見つける', () => {
  const mons: PartyMon[] = screen.map((m: any) => ({ species: m.species, item: m.item, ability: m.ability, nature: m.nature, evs: { ...m.evs }, moves: [...m.moves] }));
  const info = (s: string) => {
    const sp = dex.species[toID(s)]; if (!sp) return undefined;
    return { baseStats: sp.baseStats, abilities: Object.values(sp.abilities) as string[], movepool: new Set<string>(mons.flatMap(x => x.moves.map(toID))) };
  };
  const ja = (_k: string, n: string) => n;
  assert.deepEqual(checkParty(mons, info, ja, toID), []);
  mons[1].item = mons[0].item;
  mons[2].evs.atk = 32;
  mons[3].species = 'Salamence';
  const texts = checkParty(mons, info, ja, toID).map(p => p.text).join('\n');
  assert.match(texts, /同じ持ち物は1つまで/);
  assert.match(texts, /合計が 98/);
  assert.match(texts, /同じポケモンは1体まで/);
});

test('GitHub への書き込み：新しいファイルは sha なし、上書きは sha つきで PUT する', async () => {
  const calls: any[] = [];
  let exists = false;
  const fake = (async (url: string, init?: any) => {
    calls.push({ url, method: init?.method ?? 'GET', headers: init?.headers, body: init?.body ? JSON.parse(init.body) : undefined });
    if ((init?.method ?? 'GET') === 'GET') return new Response(exists ? JSON.stringify({ sha: 'abc' }) : '{}', { status: exists ? 200 : 404 });
    return new Response(JSON.stringify({ commit: { sha: 'c1' } }), { status: 201 });
  }) as typeof fetch;
  await putFile('tok', 'data/parties/p1.json', '{"name":"チーム2"}', 'パーティを保存', fake);
  assert.equal(calls[1].method, 'PUT');
  assert.equal(calls[1].url, 'https://api.github.com/repos/Ryota-afk/kaufhfhsyhwjaijdheysy/contents/data/parties/p1.json');
  assert.equal(calls[1].headers.Authorization, 'Bearer tok');
  assert.equal(calls[1].body.sha, undefined);
  assert.equal(calls[1].body.branch, 'main');
  assert.equal(new TextDecoder().decode(Uint8Array.from(atob(calls[1].body.content), c => c.charCodeAt(0))), '{"name":"チーム2"}');
  exists = true; calls.length = 0;
  await putFile('tok', 'data/parties/p1.json', '{}', 'パーティを保存', fake);
  assert.equal(calls[1].body.sha, 'abc');
});

test('GitHub への書き込み：権限がないと日本語で理由を返す', async () => {
  const fake = (async (_u: string, init?: any) => new Response('{}', { status: (init?.method ?? 'GET') === 'GET' ? 404 : 403 })) as typeof fetch;
  await assert.rejects(putFile('tok', 'data/parties/p1.json', '{}', 'm', fake), /Contents」の書き込みの権限がありません（403）/);
});
