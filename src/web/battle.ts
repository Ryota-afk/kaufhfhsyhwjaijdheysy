// 対戦中の画面：準備 → 毎ターンの入力 → 記録係（Worker）で盤面と推定を更新 → 探索（Worker を並べて10秒）で上位3手。
// 対戦の記録はブラウザに保存し、ページを開き直しても記録から当て直して戻る。終えたら data/logs/ にも書く（合い鍵があれば）。
import dexJson from '../engine/data/dex.json';
import type { BattleSetup, TurnInput, StartInput, VisibleState } from '../battle/analyze.ts';
import type { Position, StatusID, MonSet } from '../engine/position.ts';
import { SearchPool } from '../search/coordinator.ts';
import { putFile } from '../party/github.ts';

const base = import.meta.env.BASE_URL;
const app = document.getElementById('app')!;
const KEY_BATTLE = 'champions.currentBattle', KEY_PARTIES = 'champions.parties', KEY_TOKEN = 'champions.githubToken', KEY_TIME = 'champions.searchMs';
const dex: any = dexJson;
const toID = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const kata = (s: string) => s.replace(/[ぁ-ゖ]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60)).replace(/[\s　]/g, '');
const esc = (s: string) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const load = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const store = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* */ } };

// ---- 日本語名 ----
let ja: any;
const lookup: Record<string, Map<string, string>> = { species: new Map(), moves: new Map(), items: new Map(), abilities: new Map() };
const jn = (kind: string, id: string) => ja?.[kind]?.[toID(id)] ?? id;
function resolve(kind: string, text: string): string { const t = text.trim(); return t ? (lookup[kind].get(kata(t)) ?? lookup[kind].get(toID(t)) ?? '') : ''; }
const STATUS_JA: Record<string, string> = { '': 'なし', brn: 'やけど', par: 'まひ', psn: 'どく', tox: 'もうどく', slp: 'ねむり', frz: 'こおり' };
const BOOST_JA: Record<string, string> = { atk: 'こうげき', def: 'ぼうぎょ', spa: 'とくこう', spd: 'とくぼう', spe: 'すばやさ' };
const WEATHER_JA: Record<string, string> = { '': 'なし', raindance: 'あめ', sunnyday: 'にほんばれ', sandstorm: 'すなあらし', snowscape: 'ゆき' };
const TERRAIN_JA: Record<string, string> = { '': 'なし', electricterrain: 'エレキ', grassyterrain: 'グラス', mistyterrain: 'ミスト', psychicterrain: 'サイコ' };
const COND_JA: Record<string, string> = { stealthrock: 'ステルスロック', spikes: 'まきびし', toxicspikes: 'どくびし', stickyweb: 'ねばねばネット', reflect: 'リフレクター', lightscreen: 'ひかりのかべ', auroraveil: 'オーロラベール', tailwind: 'おいかぜ' };
const maxhp = (set: MonSet) => dex.species[toID(set.species)].baseStats.hp + set.evs.hp + 75;

// ---- 対戦の記録 ----
interface BattleDoc { id: string; partyName: string; setup: BattleSetup; start: StartInput; turns: { input: TurnInput; visible?: VisibleState }[]; startedAt: string }
let doc: BattleDoc | null = load<BattleDoc | null>(KEY_BATTLE, null);
let view: any = null;
let result: any = null;
let searching = false;
let message = '';

// ---- Worker ----
const analysis = new Worker(new URL('../engine/browser/analysis-worker.ts', import.meta.url), { type: 'module' });
function ask(msg: any): Promise<any> {
  return new Promise((res, rej) => { analysis.onmessage = ev => ev.data.type === 'error' ? rej(new Error(ev.data.message)) : res(ev.data); analysis.postMessage(msg); });
}
const pool = new SearchPool(Math.max(2, navigator.hardwareConcurrency || 2), () => new Worker(new URL('../engine/browser/search-worker.ts', import.meta.url), { type: 'module' }));

// ---- 準備の画面 ----
function partyList(): any[] { return load<any[]>(KEY_PARTIES, []).filter(p => p.mons?.filter((m: any) => m.species).length === 6); }
function renderSetup() {
  const parties = partyList();
  app.innerHTML = `
  <section class="box"><h2>対戦の準備</h2>
    ${parties.length ? '' : '<p class="warn">保存したパーティがありません。先に<a href="party.html">パーティの入力</a>で保存してください。</p>'}
    <p><label>こちらのパーティ <select id="s-party">${parties.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join('')}</select></label></p>
    <div id="s-ours"></div>
    <h3>相手の6体</h3>
    <div class="row">${[0, 1, 2, 3, 4, 5].map(i => `<input class="s-opp" data-i="${i}" list="dl-species" placeholder="${i + 1}体目" size="12">`).join(' ')}</div>
    <datalist id="dl-species">${Object.entries(ja.species).map(([, v]) => `<option value="${esc(v as string)}">`).join('')}</datalist>
    <h3>相手の先発</h3>
    <div id="s-opplead" class="row muted">（相手の6体を入れると選べます）</div>
    <p><label>先発の特性の発動（出たとき） <select id="s-oppab"><option value="">なし</option></select></label>
       <label>先発の持ち物の発動（ふうせん等） <input id="s-oppitem" list="dl-items" size="12"></label></p>
    <datalist id="dl-items">${Object.values(ja.items).map(v => `<option value="${esc(v as string)}">`).join('')}</datalist>
    <p><button id="s-start" class="primary">対戦を始める</button> <span class="warn" id="s-msg"></span></p>
  </section>`;
  const renderOurs = () => {
    const p = parties[Number((document.getElementById('s-party') as HTMLSelectElement).value)];
    document.getElementById('s-ours')!.innerHTML = p ? `<h3>こちらの選出（3体を選び、先発を1体選ぶ）</h3><table><tr><th>選ぶ</th><th>先発</th><th>ポケモン</th></tr>${p.mons.map((m: any, i: number) =>
      `<tr><td><input type="checkbox" class="s-pick" data-i="${i}"></td><td><input type="radio" name="s-lead" value="${i}"></td><td>${esc(jn('species', m.species))}</td></tr>`).join('')}</table>` : '';
  };
  (document.getElementById('s-party') as HTMLSelectElement).onchange = renderOurs; renderOurs();
  const oppIds = () => [...document.querySelectorAll<HTMLInputElement>('.s-opp')].map(x => resolve('species', x.value));
  // 6体の名前が変わったときだけ作り直す（入力欄の確定の後で押した先発のボタンが消えないように）
  let lastIds = '';
  const renderLead = () => {
    const ids = oppIds();
    if (ids.join(',') === lastIds) return;
    lastIds = ids.join(',');
    document.getElementById('s-opplead')!.innerHTML = ids.every(Boolean) ? ids.map((id, i) => `<label><input type="radio" name="s-opplead" value="${i}"> ${esc(jn('species', id))}</label>`).join(' ') : '（相手の6体を入れると選べます）';
    document.querySelectorAll<HTMLInputElement>('input[name="s-opplead"]').forEach(r => r.onchange = () => {
      const sp = dex.species[ids[Number(r.value)]];
      document.getElementById('s-oppab')!.innerHTML = '<option value="">なし</option>' + [...new Set(Object.values(sp?.abilities ?? {}))].map((a: any) => `<option value="${toID(a)}">${esc(jn('abilities', a))}</option>`).join('');
    });
  };
  document.querySelectorAll<HTMLInputElement>('.s-opp').forEach(x => x.onchange = renderLead);
  document.getElementById('s-start')!.onclick = async () => {
    const msgEl = document.getElementById('s-msg')!;
    const p = parties[Number((document.getElementById('s-party') as HTMLSelectElement).value)];
    const picks = [...document.querySelectorAll<HTMLInputElement>('.s-pick')].filter(x => x.checked).map(x => Number(x.dataset.i));
    const lead = Number((document.querySelector('input[name="s-lead"]:checked') as HTMLInputElement | null)?.value ?? -1);
    const ids = oppIds();
    const oppLead = Number((document.querySelector('input[name="s-opplead"]:checked') as HTMLInputElement | null)?.value ?? -1);
    if (!p) { msgEl.textContent = 'パーティを選んでください。'; return; }
    if (picks.length !== 3) { msgEl.textContent = 'こちらの3体を選んでください。'; return; }
    if (!picks.includes(lead)) { msgEl.textContent = '先発は、選んだ3体の中から選んでください。'; return; }
    if (!ids.every(Boolean)) { msgEl.textContent = `相手の${ids.findIndex(x => !x) + 1}体目の名前が分かりません。候補から選んでください。`; return; }
    if (oppLead < 0) { msgEl.textContent = '相手の先発を選んでください。'; return; }
    const ours: MonSet[] = picks.map(i => { const m = p.mons[i]; return { species: toID(m.species), item: toID(m.item), ability: toID(m.ability), nature: m.nature, evs: m.evs, moves: m.moves.filter(Boolean).map(toID) }; });
    const oppItem = resolve('items', (document.getElementById('s-oppitem') as HTMLInputElement).value);
    doc = {
      id: 'b' + new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14),
      partyName: p.name,
      setup: { ours, ourLead: picks.indexOf(lead), oppSpecies: ids, ourTeamJa: p.mons.map((m: any) => jn('species', m.species)) },
      start: { oppLead, oppAbility: (document.getElementById('s-oppab') as HTMLSelectElement).value || undefined, oppItem: oppItem || undefined },
      turns: [], startedAt: new Date().toISOString(),
    };
    store(KEY_BATTLE, doc);
    await refresh();
  };
}

// ---- 対戦中の画面 ----
const ourSide = () => view.pos.sides[0], oppSide = () => view.pos.sides[1];
const ourActive = () => ourSide().active as number;
const oppActiveIdx = () => view.oppOrder[oppSide().active] as number;
function choiceLabel(choice: string): string {
  const us = ourSide(); const [kind, num, mega] = choice.split(' ');
  if (kind === 'move') return `${jn('moves', us.mons[us.active].set.moves[Number(num) - 1])}${mega === 'mega' ? '（メガシンカ）' : ''}`;
  const order = [us.active, ...[0, 1, 2].filter((x: number) => x !== us.active)];
  return `交代→${jn('species', us.mons[order[Number(num) - 1]].set.species)}`;
}
function boostsText(b?: Record<string, number>) { return b ? Object.entries(b).filter(([, v]) => v).map(([k, v]) => `${BOOST_JA[k] ?? k}${v > 0 ? '+' : ''}${v}`).join(' ') : ''; }

function renderBattle() {
  const us = ourSide(), them = oppSide();
  const ua = us.mons[us.active], oaIdx = oppActiveIdx(), oa = view.opp[oaIdx], oaMon = them.mons[them.active];
  const sum = view.summaries[oaIdx];
  const megaUsedUs = !!us.megaUsed, canMegaUs = !megaUsedUs && !!dex.items[ua.set.item]?.megaStone;
  const oppAlive = view.opp.map((o: any, i: number) => ({ o, i })).filter((x: any) => !x.o.fainted);
  const top = result?.top ?? [];
  app.innerHTML = `
  <section class="box">
    <h2>ターン ${view.turn + 1}</h2>
    <p><strong>こちら</strong>：${esc(jn('species', ua.set.species))} HP ${ua.hp}/${maxhp(ua.set)} ${STATUS_JA[ua.status] !== 'なし' ? STATUS_JA[ua.status] : ''} ${esc(boostsText(ua.boosts))}
      ／ 控え：${us.mons.map((m: MonSet & any, i: number) => i === us.active ? '' : `${esc(jn('species', m.set.species))} ${m.hp}/${maxhp(m.set)}`).filter(Boolean).join('、')}</p>
    <p><strong>相手</strong>：${esc(jn('species', view.pos.sides[1].mons[them.active].set.species))} HP ${oa.hpPct}% ${STATUS_JA[oa.status] !== 'なし' ? STATUS_JA[oa.status] : ''} ${esc(boostsText(oaMon.boosts))}
      ／ 見えた体：${view.opp.map((o: any, i: number) => o.seen ? `${esc(jn('species', doc!.setup.oppSpecies[i]))}${o.fainted ? '（ひんし）' : ` ${o.hpPct}%`}` : '').filter(Boolean).join('、')}</p>
    ${view.notes.length ? `<p class="warn">${view.notes.map(esc).join('<br>')}</p>` : ''}
  </section>
  <section class="box"><h2>おすすめ（上位3手）</h2>
    <div id="result">${searching ? '<p>計算中…</p>' : top.length ? `<table><tr><th></th><th>行動</th><th>勝率</th><th>誤差</th><th>回数</th></tr>${top.map((t: any, i: number) =>
      `<tr><td>${i + 1}</td><td><strong>${esc(choiceLabel(t.choice))}</strong></td><td>${Math.round(t.winRate * 100)}%</td><td>±${Math.round(2 * t.se * 100)}</td><td>${t.n}</td></tr>`).join('')}</table>
      ${top.some((t: any) => t.closeToNext) ? '<p class="warn">勝率の差が誤差より小さい手があります（どちらを選んでも大きくは変わらない見込み）。</p>' : ''}
      <p class="muted">探索 ${result.iters} 回、${(result.ms / 1000).toFixed(1)} 秒。勝率は「この手を選んだときに勝つ見込み」の推定で、誤差は2×標準誤差。</p>` : '<p class="muted">まだ計算していません。</p>'}
    <p><button id="b-search">計算する</button> <label class="muted">計算時間 <input id="b-time" type="number" min="2" max="40" value="${Math.round(load<number>(KEY_TIME, 10000) / 1000)}" style="width:4em">秒</label></p></div>
  </section>
  <section class="box"><h2>相手の型の推定（${esc(jn('species', doc!.setup.oppSpecies[oaIdx]))}）</h2>
    ${sum ? `<p>持ち物：${sum.items.map((x: any) => `${esc(jn('items', x.name))} ${Math.round(x.p * 100)}%`).join('、')}</p>
    <p>特性：${sum.abilities.map((x: any) => `${esc(jn('abilities', x.name))} ${Math.round(x.p * 100)}%`).join('、')}</p>
    <p>技：${sum.moves.map((x: any) => `${esc(jn('moves', x.name))} ${Math.round(x.p * 100)}%`).join('、')}</p>
    ${sum.ok ? '' : '<p class="warn">どの型の候補とも合いません。入力を確かめてください。</p>'}` : ''}
  </section>
  <section class="box"><h2>このターンに起きたこと</h2>
    <p><strong>こちらの行動</strong>：${ua.set.moves.map((m: string, k: number) => `<label class="btn"><input type="radio" name="t-our" value="move ${k}"> ${esc(jn('moves', m))}</label>`).join(' ')}
      ${us.mons.map((m: any, i: number) => i !== us.active && m.hp > 0 ? `<label class="btn"><input type="radio" name="t-our" value="switch ${i}"> 交代→${esc(jn('species', m.set.species))}</label>` : '').join(' ')}
      <label class="btn"><input type="radio" name="t-our" value="none"> 動けなかった</label>
      ${canMegaUs ? '<label><input type="checkbox" id="t-ourmega"> メガシンカした</label>' : ''}</p>
    <p><strong>相手の行動</strong>：${(sum?.revealed ?? []).map((m: string) => `<label class="btn"><input type="radio" name="t-opp" value="move ${esc(m)}"> ${esc(jn('moves', m))}</label>`).join(' ')}
      <label class="btn"><input type="radio" name="t-opp" value="other"> ほかの技</label> <input id="t-oppmove" list="dl-oppmoves" size="12" placeholder="技の名前">
      <datalist id="dl-oppmoves">${(sum?.moves ?? []).map((x: any) => `<option value="${esc(jn('moves', x.name))}">`).join('')}${Object.values(ja.moves).map(v => `<option value="${esc(v as string)}">`).join('')}</datalist>
      ${oppAlive.filter((x: any) => x.i !== oaIdx).map((x: any) => `<label class="btn"><input type="radio" name="t-opp" value="switch ${x.i}"> 交代→${esc(jn('species', doc!.setup.oppSpecies[x.i]))}</label>`).join(' ')}
      <label class="btn"><input type="radio" name="t-opp" value="none"> 動けなかった</label>
      <label><input type="checkbox" id="t-oppmega"> 相手がメガシンカした</label></p>
    <p><strong>先に動いた</strong>（両方が技を出したとき）：<label class="btn"><input type="radio" name="t-first" value="us"> こちら</label> <label class="btn"><input type="radio" name="t-first" value="them"> 相手</label></p>
    <p><strong>急所</strong>：<label><input type="checkbox" id="t-critopp"> こちらの攻撃が急所</label> <label><input type="checkbox" id="t-critus"> 相手の攻撃が急所</label></p>
    <p><strong>相手の持ち物の発動</strong> <input id="t-oppitem" list="dl-items2" size="12" placeholder="なし">
       <datalist id="dl-items2">${(sum?.items ?? []).map((x: any) => `<option value="${esc(jn('items', x.name))}">`).join('')}${Object.values(ja.items).map(v => `<option value="${esc(v as string)}">`).join('')}</datalist>
       <strong>相手の特性の発動</strong> <input id="t-oppab" list="dl-ab" size="12" placeholder="なし"><datalist id="dl-ab">${Object.values(ja.abilities).map(v => `<option value="${esc(v as string)}">`).join('')}</datalist></p>
    <h3>ターンの後</h3>
    <p>こちらの場：<select id="t-ouractive">${us.mons.map((m: any, i: number) => `<option value="${i}" ${i === us.active ? 'selected' : ''}>${esc(jn('species', m.set.species))}</option>`).join('')}</select>
      HP：${us.mons.map((m: any, i: number) => `${esc(jn('species', m.set.species))} <input class="t-ourhp" data-i="${i}" type="number" min="0" max="${maxhp(m.set)}" value="${m.hp}" style="width:4.5em">`).join(' ')}
      状態異常：<select id="t-ourstatus">${Object.entries(STATUS_JA).map(([k, v]) => `<option value="${k}" ${k === (ua.status || '') ? 'selected' : ''}>${v}</option>`).join('')}</select></p>
    <p>相手の場：<select id="t-oppactive">${oppAlive.map((x: any) => `<option value="${x.i}" ${x.i === oaIdx ? 'selected' : ''}>${esc(jn('species', doc!.setup.oppSpecies[x.i]))}</option>`).join('')}</select>
      HP <input id="t-opphp" type="number" min="0" max="100" value="${oa.hpPct}" style="width:4em">%
      状態異常：<select id="t-oppstatus">${Object.entries(STATUS_JA).map(([k, v]) => `<option value="${k}" ${k === (oa.status || '') ? 'selected' : ''}>${v}</option>`).join('')}</select></p>
    <p><button id="t-record" class="primary">記録して計算</button> <span class="warn" id="t-msg"></span></p>
  </section>
  <section class="box"><h2>今の状態（画面と違えば直す）</h2>${stateForm()}
    <p><button id="v-apply">状態を直して計算</button></p></section>
  <section class="box"><h2>記録</h2>
    <p class="muted">${esc(doc!.partyName)}、${doc!.turns.length} ターン記録済み。</p>
    <p><button id="b-undo">1ターン取り消す</button> <button id="b-end">対戦を終える（記録を保存）</button> <span>${esc(message)}</span></p>
  </section>`;
  bindBattle();
}

function stateForm() {
  const us = ourSide(), them = oppSide();
  const boostRow = (si: number, mon: any) => Object.keys(BOOST_JA).map(k => `${BOOST_JA[k]} <select class="v-boost" data-s="${si}" data-k="${k}">${[-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6].map(v => `<option value="${v}" ${(mon.boosts?.[k] ?? 0) === v ? 'selected' : ''}>${v > 0 ? '+' : ''}${v}</option>`).join('')}</select>`).join(' ');
  const f = view.pos.field ?? {};
  const condRow = (si: number, c: any = {}) => Object.keys(COND_JA).map(k => ['spikes', 'toxicspikes'].includes(k)
    ? `${COND_JA[k]} <select class="v-cond" data-s="${si}" data-k="${k}">${[0, 1, 2, 3].slice(0, k === 'spikes' ? 4 : 3).map(v => `<option value="${v}" ${(c[k] ?? 0) === v ? 'selected' : ''}>${v}</option>`).join('')}</select>`
    : `<label><input type="checkbox" class="v-cond" data-s="${si}" data-k="${k}" ${c[k] ? 'checked' : ''}> ${COND_JA[k]}</label>`).join(' ');
  return `<p>こちらの能力ランク：${boostRow(0, us.mons[us.active])}</p>
    <p>相手の能力ランク：${boostRow(1, them.mons[them.active])}</p>
    <p>天気 <select id="v-weather">${Object.entries(WEATHER_JA).map(([k, v]) => `<option value="${k}" ${(f.weather?.id ?? '') === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
       フィールド <select id="v-terrain">${Object.entries(TERRAIN_JA).map(([k, v]) => `<option value="${k}" ${(f.terrain?.id ?? '') === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
       <label><input type="checkbox" id="v-tr" ${f.trickroom ? 'checked' : ''}> トリックルーム</label></p>
    <p>こちらの場：${condRow(0, us.cond)}</p><p>相手の場：${condRow(1, them.cond)}</p>`;
}
function readVisible(): VisibleState {
  const boosts: [any, any] = [{}, {}];
  document.querySelectorAll<HTMLSelectElement>('.v-boost').forEach(s => { const v = Number(s.value); if (v) boosts[Number(s.dataset.s)][s.dataset.k!] = v; });
  const cond: [any, any] = [{}, {}];
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('.v-cond').forEach(x => {
    const v = x instanceof HTMLInputElement ? (x.checked ? 1 : 0) : Number(x.value);
    if (v) cond[Number(x.dataset.s)][x.dataset.k!] = v;
  });
  return { boosts, cond, weather: (document.getElementById('v-weather') as HTMLSelectElement).value, terrain: (document.getElementById('v-terrain') as HTMLSelectElement).value, trickroom: (document.getElementById('v-tr') as HTMLInputElement).checked };
}

function bindBattle() {
  document.getElementById('b-search')!.onclick = () => runSearch();
  (document.getElementById('b-time') as HTMLInputElement).onchange = e => store(KEY_TIME, Math.max(2, Math.min(40, Number((e.target as HTMLInputElement).value))) * 1000);
  document.getElementById('t-record')!.onclick = recordTurn;
  document.getElementById('v-apply')!.onclick = async () => {
    const visible = readVisible();
    if (doc!.turns.length) doc!.turns[doc!.turns.length - 1].visible = visible;
    else (doc as any).startVisible = visible;
    store(KEY_BATTLE, doc);
    result = null; searching = true;
    (document.getElementById('result') as HTMLElement).innerHTML = '<p>直して計算中…</p>';
    try { view = (await ask({ type: 'edit', visible })).view; } finally { searching = false; }
    renderBattle(); runSearch();
  };
  document.getElementById('b-undo')!.onclick = async () => {
    if (!doc!.turns.length) return;
    if (!confirm('最後のターンの記録を取り消しますか？')) return;
    doc!.turns.pop(); store(KEY_BATTLE, doc); await refresh();
  };
  document.getElementById('b-end')!.onclick = async () => {
    if (!confirm('対戦を終えて、記録を保存しますか？（この画面の記録は消え、準備の画面に戻ります）')) return;
    const outcome = prompt('結果を入れてください（勝ち／負け）', '') ?? '';
    const logDoc = { ...doc, endedAt: new Date().toISOString(), outcome };
    const logs = load<any[]>('champions.logs', []); logs.push(logDoc); store('champions.logs', logs);
    const token = (() => { try { return localStorage.getItem(KEY_TOKEN) ?? ''; } catch { return ''; } })();
    let saved = 'このブラウザに保存しました。';
    if (token) {
      try { await putFile(token, `data/logs/${doc!.id}.json`, JSON.stringify(logDoc, null, 1) + '\n', `対戦の記録：${doc!.partyName}`); saved = 'このブラウザとリポジトリに保存しました。'; }
      catch (e: any) { saved = `このブラウザには保存しました。リポジトリへの書き込みは失敗しました：${e.message}`; }
    }
    try { localStorage.removeItem(KEY_BATTLE); } catch { /* */ }
    doc = null; view = null; result = null; renderSetup();
    app.insertAdjacentHTML('afterbegin', `<p>${esc(saved)}</p>`);
  };
}

async function recordTurn() {
  const msgEl = document.getElementById('t-msg')!;
  const our = (document.querySelector('input[name="t-our"]:checked') as HTMLInputElement | null)?.value;
  const opp = (document.querySelector('input[name="t-opp"]:checked') as HTMLInputElement | null)?.value;
  if (!our) { msgEl.textContent = 'こちらの行動を選んでください。'; return; }
  if (!opp) { msgEl.textContent = '相手の行動を選んでください。'; return; }
  const [ok, ov] = our.split(' ');
  const ours: TurnInput['ours'] = ok === 'none' ? { kind: 'none' } : ok === 'switch' ? { kind: 'switch', to: Number(ov) } : { kind: 'move', slot: Number(ov), mega: !!(document.getElementById('t-ourmega') as HTMLInputElement | null)?.checked };
  let oppAct: TurnInput['opp'];
  if (opp === 'none') oppAct = { kind: 'none' };
  else if (opp.startsWith('switch')) oppAct = { kind: 'switch', to: Number(opp.split(' ')[1]) };
  else {
    const mv = opp === 'other' ? resolve('moves', (document.getElementById('t-oppmove') as HTMLInputElement).value) : opp.slice(5);
    if (!mv) { msgEl.textContent = '相手の技の名前が分かりません。候補から選んでください。'; return; }
    oppAct = { kind: 'move', move: mv };
  }
  const first = (document.querySelector('input[name="t-first"]:checked') as HTMLInputElement | null)?.value as 'us' | 'them' | undefined;
  if (ours.kind === 'move' && oppAct.kind === 'move' && !first) { msgEl.textContent = 'どちらが先に動いたかを選んでください。'; return; }
  const itemText = (document.getElementById('t-oppitem') as HTMLInputElement).value, abText = (document.getElementById('t-oppab') as HTMLInputElement).value;
  const oppItem = itemText ? resolve('items', itemText) : '', oppAbility = abText ? resolve('abilities', abText) : '';
  if (itemText && !oppItem) { msgEl.textContent = '相手の持ち物の名前が分かりません。'; return; }
  if (abText && !oppAbility) { msgEl.textContent = '相手の特性の名前が分かりません。'; return; }
  const ourHps = [...document.querySelectorAll<HTMLInputElement>('.t-ourhp')].map(x => Number(x.value));
  const ourActive = Number((document.getElementById('t-ouractive') as HTMLSelectElement).value);
  const input: TurnInput = {
    ours, opp: oppAct, first: ours.kind === 'move' && oppAct.kind === 'move' ? first : undefined,
    critOnOpp: (document.getElementById('t-critopp') as HTMLInputElement).checked, critOnUs: (document.getElementById('t-critus') as HTMLInputElement).checked,
    oppItem: oppItem || undefined, oppAbility: oppAbility || undefined,
    ourMega: !!(document.getElementById('t-ourmega') as HTMLInputElement | null)?.checked, oppMega: (document.getElementById('t-oppmega') as HTMLInputElement).checked,
    after: {
      ourActive, ourHp: ourHps[ourActive], ourStatus: (document.getElementById('t-ourstatus') as HTMLSelectElement).value as StatusID,
      oppActive: Number((document.getElementById('t-oppactive') as HTMLSelectElement).value), oppHpPct: Number((document.getElementById('t-opphp') as HTMLInputElement).value),
      oppStatus: (document.getElementById('t-oppstatus') as HTMLSelectElement).value as StatusID, ourHps,
    },
  };
  doc!.turns.push({ input });
  store(KEY_BATTLE, doc);
  // 前のターンのおすすめを、押した時点で消す（記録の途中で古いおすすめを見せない）
  result = null; searching = true;
  (document.getElementById('result') as HTMLElement).innerHTML = '<p>記録して計算中…</p>';
  try { view = (await ask({ type: 'record', input })).view; } finally { searching = false; }
  renderBattle();
  runSearch();
}

async function runSearch() {
  if (!view) return;
  searching = true; renderBattle();
  try {
    const timeMs = load<number>(KEY_TIME, 10000);
    const { positions } = await ask({ type: 'dets', k: 8, seed: Date.now() & 0xffffffff });
    result = await pool.run(positions as Position[], timeMs);
  } catch (e: any) { message = `計算のエラー：${e.message}`; }
  searching = false; renderBattle();
}

async function refresh() {
  if (!doc) { renderSetup(); return; }
  app.innerHTML = '<p>記録から盤面を作っています…</p>';
  view = (await ask({ type: 'replay', battle: doc })).view;
  if ((doc as any).startVisible && !doc.turns.length) view = (await ask({ type: 'edit', visible: (doc as any).startVisible })).view;
  result = null;
  renderBattle();
  runSearch();
}

async function main() {
  ja = await (await fetch(`${base}data/names/ja.json`)).json();
  for (const kind of ['species', 'moves', 'items', 'abilities'] as const) {
    for (const [id, name] of Object.entries(ja[kind] as Record<string, string>)) { lookup[kind].set(id, id); lookup[kind].set(kata(name), id); }
  }
  for (const [id, al] of Object.entries(ja.speciesAliases ?? {}) as [string, string[]][]) for (const a of al) lookup.species.set(kata(a), id);
  await ask({ type: 'load', priorsUrl: `${base}data/priors/sets.json`, teamsUrl: `${base}data/seed/teams_m7.json`, selectionsUrl: `${base}data/seed/selections_m7.json` });
  await refresh();
}
(window as any).__battle = { get doc() { return doc; }, get view() { return view; }, get result() { return result; }, get searching() { return searching; } };
main().catch(e => { app.innerHTML = `<p>エラー：${esc(String(e?.message ?? e))}</p>`; });
