// 対戦の画面の流れの確かめ（Playwright、Chromium）。先に npm run build が必要。
// Node で Showdown の対戦を決着まで本当に打ち、利用者と同じ操作で画面に入れていく。倒れた後の交代先は無作為に選び、
// こちらが倒れたら死に出しの画面で入れる。毎回、画面の状態（記録係の盤面）が本当と一致するかを見る：
//   場の体（両方）、こちらの3体の HP、相手の見えた体の HP% と倒れたか、死に出しの場面か、決着したか。ページのエラーがないか。
// 使い方：npx tsx tools/browser/flow-e2e.ts [試合数=3] [種=1] [計算の秒数=2] [交代技を選ぶ割合=0]
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loadShowdown, FORMAT } from '../showdown/load.ts';
import { makeRunner } from '../../src/engine/runner.ts';
import { shownPercent } from '../../src/infer/calc.ts';
import type { Action, Position, StatusID } from '../../src/engine/position.ts';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const [GAMES, SEED, SECS, PIVOT] = [3, 1, 2, 0].map((d, i) => Number(process.argv[2 + i] ?? d));
const PS = loadShowdown(); const dex = PS.Dex.forFormat(FORMAT); const Runner = makeRunner(PS, FORMAT);
const ja = JSON.parse(readFileSync('data/names/ja.json', 'utf8'));
const party = JSON.parse(readFileSync('test/fixtures/party-team2-screen.json', 'utf8'));
const teams = JSON.parse(readFileSync('data/seed/teams_m7.json', 'utf8'));
const validator = PS.TeamValidator.get(FORMAT);
const okTeams = teams.filter((t: any) => !validator.validateTeam(t.mons.map((m: any) => ({ ...m, name: '', level: 50, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 } }))));
const toID = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const J = (kind: string, n: string) => ja[kind][toID(n)] ?? n;
const base = (sp: string) => dex.species.get(sp).baseSpecies;
let st = SEED * 7907 + 3; const rand = () => { st = (st * 16807) % 2147483647; return st / 2147483647; };
const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
// 打った後に交代する技（Showdown の selfSwitch）。選べるとき、PIVOT の割合で選ぶ
const isPivot = (b: any, si: number, a: Action | null) => { if (!a || a.kind !== 'move') return false; return !!dex.moves.get(b.sides[si].active[0].moveSlots[a.slot]?.id).selfSwitch; };
const pickAct = (b: any, si: number, xs: Action[]) => { const pv = xs.filter(a => isPivot(b, si, a)); return pv.length && rand() < PIVOT ? pick(pv) : pick(xs); };
let pivotButtons = 0, pivots = 0, pivotFixes = 0, pivotWrong = 0, plain = 0, plainFixes = 0, plainWrong = 0;
const setOf = (m: any) => ({ species: m.species, item: toID(m.item), ability: toID(m.ability), nature: m.nature, evs: m.evs, moves: m.moves.map(toID) });

const server = spawn('npx', ['vite', 'preview', '--port', '4181', '--strictPort'], { stdio: 'ignore', detached: true });
const url = 'http://localhost:4181/kaufhfhsyhwjaijdheysy/battle.html';
for (let i = 0; i < 50; i++) { try { await fetch(url); break; } catch { await new Promise(r => setTimeout(r, 300)); } }
const browser = await chromium.launch();
const errors: string[] = [];
const bad: Record<string, number> = {}; const samples: string[] = [];
const note = (k: string, m: string) => { bad[k] = (bad[k] ?? 0) + 1; if (samples.length < 40) samples.push(`${k}：${m}`); };
let turns = 0, replaces = 0, ends = 0, opsTotal = 0, opsTurns = 0;
const partyDoc = { id: 'p-test', name: 'チーム2', updatedAt: '', mons: party.map((m: any) => ({ species: m.species, item: m.item, ability: m.ability, nature: m.nature, evs: m.evs, moves: m.moves, gender: m.gender })) };

for (let g = 0; g < GAMES; g++) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.on('pageerror', (e: any) => errors.push(String(e)));
  page.on('console', (m: any) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.addInitScript(([p, ms]: any) => { localStorage.clear(); localStorage.setItem('champions.parties', JSON.stringify([p])); localStorage.setItem('champions.searchMs', String(ms)); }, [partyDoc, SECS * 1000]);
  await page.goto(url); await page.waitForSelector('#s-start', { timeout: 60000 });
  const team: any = pick(okTeams);
  // LEAD=番号 のときは、その番号のポケモンを先発にして選出に入れる（交代技を持つポケモンの確かめ用）
  const forced = process.env.LEAD !== undefined ? Number(process.env.LEAD) : -1;
  let picks = [0, 1, 2, 3, 4, 5].sort(() => rand() - 0.5).slice(0, 3).sort((a, b) => a - b), lead = pick(picks);
  if (forced >= 0) { if (!picks.includes(forced)) picks = [...picks.slice(0, 2), forced].sort((a, b) => a - b); lead = forced; }
  const oppPicks = [0, 1, 2, 3, 4, 5].sort(() => rand() - 0.5).slice(0, 3);
  for (let i = 0; i < 6; i++) { await page.fill(`.s-opp[data-i="${i}"]`, J('species', team.mons[i].species)); await page.dispatchEvent(`.s-opp[data-i="${i}"]`, 'change'); }
  await page.waitForFunction(() => /くじの結果|計算できません/.test(document.getElementById('s-select')?.innerText ?? ''), null, { timeout: 60000 });
  for (let i = 0; i < 6; i++) { const want = picks.includes(i); if ((await page.isChecked(`.s-pick[data-i="${i}"]`)) !== want) await page.click(`.s-pick[data-i="${i}"]`); }
  await page.check(`input[name="s-lead"][value="${lead}"]`);
  await page.click(`input[name="s-opplead"][value="${oppPicks[0]}"]`);
  // 本当の対戦：こちらは選んだ3体（番号の順）、先発は lead
  const ours = picks.map(i => setOf(party[i]));
  const pos: Position = { sides: [
    { mons: ours.map(s => ({ set: s, hp: 999, status: '' as StatusID })), active: picks.indexOf(lead) },
    { mons: oppPicks.map(i => ({ set: setOf(team.mons[i]), hp: 999, status: '' as StatusID })), active: 0 },
  ] };
  const truth = new Runner(pos, g + 11, true); const b = truth.battle;
  const leadAb = (b.log as string[]).map(l => /^\|-ability\|p2a: [^|]*\|([^|]*)/.exec(l)?.[1]).find(Boolean);
  if (leadAb) await page.selectOption('#s-oppab', toID(leadAb));
  await page.click('#s-start');
  const oppSpecies = team.mons.map((m: any) => m.species);
  const oppIdxOf = (p: any) => oppSpecies.findIndex((n: string) => base(n) === p.baseSpecies.baseSpecies);
  const ourIdxOf = (p: any) => ours.findIndex(o => base(o.species) === p.baseSpecies.baseSpecies);
  const truthHps = () => ours.map(o => b.sides[0].pokemon.find((p: any) => p.baseSpecies.baseSpecies === base(o.species)).hp);
  const pctOf = (i: number) => { const p = b.sides[1].pokemon.find((q: any) => oppIdxOf(q) === i); return p ? shownPercent(p.hp, p.maxhp) : null; };
  const waitIdle = async () => page.waitForFunction(() => { const w = (window as any).__battle; return w && w.view && !w.searching; }, null, { timeout: (SECS + 60) * 1000 });
  const compare = async (where: string) => {
    const v = await page.evaluate(() => { const w = (window as any).__battle; return { pos: w.view.pos, opp: w.view.opp, oppOrder: w.view.oppOrder, pending: w.view.pending ?? [] }; });
    const ta = ourIdxOf(b.sides[0].active[0]);
    if (v.pos.sides[0].active !== ta) note('こちらの場の体', `${where} 画面 ${v.pos.sides[0].active} ／ 本当 ${ta}`);
    const ah = v.pos.sides[0].mons.map((m: any) => m.hp), th = truthHps();
    if (JSON.stringify(ah) !== JSON.stringify(th)) note('こちらの HP', `${where} 画面 ${JSON.stringify(ah)} ／ 本当 ${JSON.stringify(th)}`);
    const oa = v.oppOrder[v.pos.sides[1].active], toa = oppIdxOf(b.sides[1].active[0]);
    if (oa !== toa) { note('相手の場の体', `${where} 画面 ${oppSpecies[oa]} ／ 本当 ${oppSpecies[toa]}`); if (process.env.WHY_DUMP) writeFileSync(`${process.env.WHY_DUMP}/opp-${where.replace(/\s/g, '_')}.json`, await page.evaluate(() => localStorage.getItem('champions.currentBattle')) ?? ''); }
    for (const p of b.sides[1].pokemon) {
      const i = oppIdxOf(p); if (!v.opp[i].seen) continue;
      const pct = shownPercent(p.hp, p.maxhp);
      if (v.opp[i].hpPct !== pct) note('相手の HP%', `${where} ${oppSpecies[i]} 画面 ${v.opp[i].hpPct} ／ 本当 ${pct}`);
      if (!!v.opp[i].fainted !== (p.hp <= 0)) note('相手が倒れたか', `${where} ${oppSpecies[i]} 画面 ${v.opp[i].fainted} ／ 本当 ${p.hp <= 0}`);
    }
    return v;
  };
  await waitIdle();
  let ops = 0;
  const clickRadio = async (name: string, value: string) => { await page.click(`label:has(> input[name="${name}"][value="${value}"])`); ops++; };
  const setNum = async (sel: string, v: number) => { if (String(v) !== await page.$eval(sel, (x: any) => x.value)) { await page.fill(sel, String(v)); await page.dispatchEvent(sel, 'input'); ops++; } };
  const setSel = async (sel: string, v: string) => { if (v !== await page.$eval(sel, (x: any) => x.value)) { await page.selectOption(sel, v); ops++; return true; } return false; };
  // 場の体を直すと、画面がその条件で予想し直す。予想が入り終わるまで待つ
  const waitPred = async () => page.waitForFunction(() => /予想を入れました|予想できません/.test(document.getElementById('t-predmsg')?.textContent ?? ''), null, { timeout: 30000 });
  for (let t = 0; t < 60 && !b.ended; t++) {
    const l0 = truth.legalActions(0), l1 = truth.legalActions(1);
    const foeBefore = b.sides[1].active[0];
    const from = b.log.length, turnBefore = b.turn;
    let a0: Action | null = null, a1: Action | null = null, pivotTurn = false, isPivot0 = false;
    const ourBefore = ourIdxOf(b.sides[0].active[0]);
    for (let tries = 0; tries < 8; tries++) {
      a0 = l0.length ? pickAct(b, 0, l0) : null; a1 = l1.length ? pickAct(b, 1, l1) : null;
      isPivot0 = isPivot(b, 0, a0); pivotTurn = isPivot0 || isPivot(b, 1, a1);
      for (const sd of b.sides) if (sd.activeRequest && !sd.activeRequest.wait) sd.choice = { cantUndo: false, error: '', actions: [], forcedSwitchesLeft: 0, forcedPassesLeft: 0, switchIns: new Set(), zMove: false, mega: false, ultra: false, dynamax: false, terastallize: false };
      truth.play(a0, a1, 0);
      if (b.turn !== turnBefore || b.ended || b.requestState === 'switch') break;
    }
    if (b.turn === turnBefore && !b.ended && b.requestState !== 'switch') break;
    let guard = 0;
    while (!b.ended && b.requestState === 'switch' && guard++ < 6) {
      const ourNeeds = !!b.sides[0].activeRequest?.forceSwitch, oppNeeds = !!b.sides[1].activeRequest?.forceSwitch;
      if (ourNeeds && b.sides[0].active[0].fainted) break;
      if (oppNeeds && !ourNeeds && b.sides[1].active[0].fainted) { b.choose('p2', truth.choiceString(1, pick(truth.legalActions(1)))); continue; }
      if (ourNeeds) b.choose('p1', truth.choiceString(0, pick(truth.legalActions(0))));
      if (oppNeeds) b.choose('p2', truth.choiceString(1, pick(truth.legalActions(1))));
    }
    const lines = (b.log as string[]).slice(from);
    const v0hps: number[] = await page.evaluate(() => (window as any).__battle.view.pos.sides[0].mons.map((m: any) => m.hp));
    const own = (l: string) => !l.includes('[from]') || l.includes('[from] lockedmove');
    ops = 0;
    // ① 相手の行動 ② こちらの行動
    const oppMoveLine = lines.find(l => l.startsWith(`|move|p2a: ${foeBefore.name}|`) && own(l));
    // 相手の交代先：本当の対戦の並び（oppPicks の順）の番号 → 6体の番号
    if (a1?.kind === 'switch') await clickRadio('t-opp', `switch ${oppPicks[a1.to]}`);
    else if (oppMoveLine) {
      const mv = oppMoveLine.split('|')[3];
      if (await page.$(`input[name="t-opp"][value="move ${toID(mv)}"]`)) await clickRadio('t-opp', `move ${toID(mv)}`);
      else { await clickRadio('t-opp', 'other'); await page.fill('#t-oppmove', J('moves', mv)); await page.dispatchEvent('#t-oppmove', 'change'); ops++; }
    } else await clickRadio('t-opp', 'none');
    if (lines.some(l => l.startsWith('|-mega|p2a')) && await page.$('#t-oppmega')) { await page.click('#t-oppmega'); ops++; }
    const ourMoved = lines.some(l => l.startsWith('|move|p1a') && own(l));
    if (a0?.kind === 'switch') await clickRadio('t-our', `switch ${a0.to}`);
    else if (a0?.kind === 'move' && ourMoved) await clickRadio('t-our', `move ${a0.slot}`);
    else await clickRadio('t-our', 'none');
    if (lines.some(l => l.startsWith('|-mega|p1a')) && await page.$('#t-ourmega')) { await page.click('#t-ourmega'); ops++; }
    await page.waitForFunction(() => /予想を入れました|予想できません/.test(document.getElementById('t-predmsg')?.textContent ?? ''), null, { timeout: 30000 });
    // ③ 結果：本当と違う欄だけ直す
    const moveLines = lines.filter(l => /^\|move\|p[12]a:/.test(l) && own(l));
    if (a0?.kind === 'move' && ourMoved && a1?.kind !== 'switch' && oppMoveLine && moveLines.length >= 2) {
      const want = moveLines[0].startsWith('|move|p2a') ? 'them' : 'us';
      if (await page.$eval('input[name="t-first"]:checked', (x: any) => x.value).catch(() => '') !== want) { await clickRadio('t-first', want); await waitPred(); }
    }
    const toa = oppIdxOf(b.sides[1].active[0]);
    // 場の体（交代技の交代先など）を先に直し、予想し直すのを待ってから、ほかの欄を直す
    if (await setSel('#t-oppactive', String(toa))) await waitPred();
    // こちらが交代技を打って入れ替わったら、②の下の交代先のボタンで入れる（ボタンが出ていることも確かめる）
    const ourNow = ourIdxOf(b.sides[0].active[0]);
    if (a0?.kind === 'move' && ourMoved && isPivot0 && ourNow !== ourBefore && !b.sides[0].active[0].fainted) {
      if (!(await page.isVisible('#row-pivot'))) note('交代先のボタン', `試合${g} ターン${t}：交代技を選んだのに交代先のボタンが出ない`);
      else { await clickRadio('t-pivot', String(ourNow)); await waitPred(); pivotButtons++; }
    }
    if (await setSel('#t-ouractive', String(ourNow))) await waitPred();
    await setNum('#t-opphp', shownPercent(b.sides[1].active[0].hp, b.sides[1].active[0].maxhp));
    for (const el of await page.$$('input.t-oppother')) { const i = Number(await el.getAttribute('data-i')); const pct = pctOf(i); if (pct !== null) await setNum(`input.t-oppother[data-i="${i}"]`, pct); }
    const th = truthHps();
    const opsBeforeHp = ops;
    // 予想が「別の体」を外したか：予想が無傷なのに本当は減った、または予想が減ったのに本当は変わらない欄
    const shown = await Promise.all([0, 1, 2].map(k => page.$eval(`.t-ourhp[data-i="${k}"]`, (x: any) => Number(x.value))));
    const beforeHps = v0hps;
    const wrongMon = [0, 1, 2].filter(k => (shown[k] === beforeHps[k]) !== (th[k] === beforeHps[k])).length;
    if (wrongMon && process.env.WHY) console.log(`外れ 試合${g} ターン${t}${pivotTurn ? '（交代技）' : ''}：${await page.$eval('#t-predmsg', (x: any) => x.textContent)} 前 ${JSON.stringify(beforeHps)} 予想 ${JSON.stringify(shown)} 本当 ${JSON.stringify(th)}\n    ` + lines.filter(l => /^\|(move|switch|drag|-damage|-heal|-crit|-miss|-activate|-immune|faint|-fail)\|/.test(l)).join(' ').slice(0, 700));
    for (let k = 0; k < 3; k++) await setNum(`.t-ourhp[data-i="${k}"]`, th[k]);
    if (pivotTurn) { pivots++; pivotFixes += ops - opsBeforeHp; pivotWrong += wrongMon; } else { plain++; plainFixes += ops - opsBeforeHp; plainWrong += wrongMon; }
    await setSel('#t-ourstatus', b.sides[0].active[0].fainted ? (await page.$eval('#t-ourstatus', (x: any) => x.value)) : (b.sides[0].active[0].status || ''));
    await setSel('#t-oppstatus', b.sides[1].active[0].fainted ? (await page.$eval('#t-oppstatus', (x: any) => x.value)) : (b.sides[1].active[0].status || ''));
    await page.click('#t-record'); ops++;
    if (wrongMon && process.env.WHY_DUMP) { const d = await page.evaluate(() => localStorage.getItem('champions.currentBattle')); writeFileSync(`${process.env.WHY_DUMP}/g${g}t${t}.json`, d ?? ''); }
    const msg = await page.$eval('#t-msg', (x: any) => x.textContent).catch(() => '');
    if (msg) { note('記録できない', `試合${g} ターン${t}：${msg}`); break; }
    await waitIdle();
    opsTotal += ops; opsTurns++; turns++;
    const v = await compare(`試合${g} ターン${t}`);
    if (b.ended) {
      ends++;
      if (!(await page.$('#b-end2'))) note('決着の表示', `試合${g}：本当は決着したのに、画面に対戦の終わりが出ない`);
      break;
    }
    const tp: number[] = [];
    if (b.requestState === 'switch' && b.sides[0].activeRequest?.forceSwitch) tp.push(0);
    if (b.requestState === 'switch' && b.sides[1].activeRequest?.forceSwitch) tp.push(1);
    if (JSON.stringify(v.pending) !== JSON.stringify(tp)) note('死に出しの場面の判定', `試合${g} ターン${t} 画面 ${JSON.stringify(v.pending)} ／ 本当 ${JSON.stringify(tp)}`);
    if (tp.length) {
      if (!(await page.$('#r-record'))) { note('死に出しの画面', `試合${g} ターン${t}：死に出しの画面が出ない`); break; }
      const c0 = tp.includes(0) ? pick(truth.legalActions(0)) as any : null, c1 = tp.includes(1) ? pick(truth.legalActions(1)) as any : null;
      if (c0) b.choose('p1', truth.choiceString(0, c0));
      if (c1) b.choose('p2', truth.choiceString(1, c1));
      if (c0) await clickRadio('r-our', String(c0.to));
      if (c1) await clickRadio('r-opp', String(oppIdxOf(b.sides[1].active[0])));
      await page.waitForFunction(() => /予想を入れました|予想できません/.test(document.getElementById('r-predmsg')?.textContent ?? ''), null, { timeout: 30000 });
      const th2 = truthHps();
      for (const el of await page.$$('.r-ourhp')) { const k = Number(await el.getAttribute('data-i')); await setNum(`.r-ourhp[data-i="${k}"]`, th2[k]); }
      if (c1) await setNum('#r-opphp', shownPercent(b.sides[1].active[0].hp, b.sides[1].active[0].maxhp));
      await page.click('#r-record');
      await waitIdle();
      replaces++;
      await compare(`試合${g} ターン${t} 死に出しの後`);
    }
  }
  await page.close();
}
await browser.close();
try { process.kill(-server.pid!); } catch { /* もう止まっている */ }
console.log(`試合 ${GAMES}、ターン ${turns}、死に出し ${replaces}、決着 ${ends}。1ターンの操作の平均 ${(opsTotal / Math.max(1, opsTurns)).toFixed(1)}回`);
console.log(`交代先のボタンで入れたターン ${pivotButtons}`);
console.log(`こちらの HP の予想（場の体を直して予想し直した後）：交代技のターン ${pivots}：直した欄 ${pivotFixes}、うち別の体を外した欄 ${pivotWrong}／ほかのターン ${plain}：直した欄 ${plainFixes}、うち別の体を外した欄 ${plainWrong}`);
console.log(Object.keys(bad).length ? `ずれ：${JSON.stringify(bad)}` : 'ずれ：なし');
for (const x of samples) console.log('  ' + x);
console.log(`ページのエラー ${errors.length}件 ${JSON.stringify(errors.slice(0, 5))}`);
process.exit(Object.keys(bad).length || errors.length ? 1 : 0);
