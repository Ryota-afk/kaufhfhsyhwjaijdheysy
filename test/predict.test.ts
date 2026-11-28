// 結果の予想（記録係の predict）：交代技（ボルトチェンジ）の交代先と、先手・後手で、どの体がダメージを受けるかが変わること。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadShowdown, FORMAT } from '../tools/showdown/load.ts';
import { makeAnalyzer } from '../src/battle/analyze.ts';

const PS = loadShowdown();
const toID = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const Analyzer = makeAnalyzer(PS, FORMAT, JSON.parse(readFileSync('data/priors/sets.json', 'utf8')), JSON.parse(readFileSync('data/seed/teams_m7.json', 'utf8')), JSON.parse(readFileSync('data/seed/selections_m7.json', 'utf8')));
const party = JSON.parse(readFileSync('test/fixtures/party-team2-screen.json', 'utf8'));
const setOf = (m: any) => ({ species: m.species, item: toID(m.item), ability: toID(m.ability), nature: m.nature, evs: m.evs, moves: m.moves.map(toID) });
const team = JSON.parse(readFileSync('data/seed/teams_m7.json', 'utf8')).find((t: any) => t.rank === 1);

// こちら：ヒートロトム（先発、ボルトチェンジ）・バサギリ・ガブリアス。相手：1位の構築のブリジュラス（りゅうせいぐん）
const ours = [party[4], party[5], party[2]].map(setOf);
const make = () => {
  const an = new Analyzer({ ours, ourLead: 0, oppSpecies: team.mons.map((m: any) => m.species), ourTeamJa: [] });
  an.start({ oppLead: 3 });
  return an;
};
const volt = ours[0].moves.indexOf('voltswitch');
const input = { ours: { kind: 'move' as const, slot: volt }, opp: { kind: 'move' as const, move: 'dracometeor' } };
const full = (an: any, k: number) => an.pos.sides[0].mons[k].hp;

test('交代技：先にボルトチェンジを打ったら、相手の攻撃は出てきた体（決めた交代先）が受ける', () => {
  const an = make();
  for (const to of [1, 2]) {
    const p = an.predict(input, 24, { ourTo: to, first: 'us' })!;
    assert.equal(p.ourActive, to, `交代先 ${to}`);
    assert.equal(p.ourHps[0], full(an, 0), '下がったヒートロトムは無傷');
    assert.ok(p.ourHps[to] < full(an, to), `出てきた体 ${to} がダメージを受ける`);
    const other = 3 - to;
    assert.equal(p.ourHps[other], full(an, other), '控えのままの体は無傷');
  }
});

test('交代技：後からボルトチェンジを打ったら、相手の攻撃は下がる前の体が受け、出てきた体は無傷', () => {
  const an = make();
  const p = an.predict(input, 24, { ourTo: 2, first: 'them' })!;
  assert.equal(p.ourActive, 2);
  assert.ok(p.ourHps[0] < full(an, 0), 'ヒートロトムがダメージを受ける');
  assert.equal(p.ourHps[2], full(an, 2), '出てきたガブリアスは無傷');
  assert.equal(p.ourHps[1], full(an, 1));
});
