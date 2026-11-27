// パーティの入力・保存の画面。
// 保存すると、ブラウザ（localStorage）と、合い鍵があればリポジトリ（data/parties/）の両方に書く。
import { STATS, STAT_JA, SP_MAX, SP_TOTAL, calcStat, checkParty, emptyMon, newParty, type Party, type PartyMon, type MonInfo, type StatID } from '../party/model.ts';
import { putFile } from '../party/github.ts';

const base = import.meta.env.BASE_URL;
const app = document.getElementById('app')!;
const KEY_PARTIES = 'champions.parties';
const KEY_CURRENT = 'champions.currentParty';
const KEY_TOKEN = 'champions.githubToken';

// ---- 保存場所（ブラウザ） ----
function load<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function store(key: string, v: unknown) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* 保存できない環境 */ } }
function getToken(): string { try { return localStorage.getItem(KEY_TOKEN) ?? ''; } catch { return ''; } }

// ---- 名前（日本語⇔英語） ----
const toID = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const kata = (s: string) => s.replace(/[ぁ-ゖ]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60)).replace(/[\s　]/g, '');
interface Names { species: Record<string, string>; moves: Record<string, string>; items: Record<string, string>; abilities: Record<string, string>; natures: Record<string, string>; speciesAliases: Record<string, string[]> }
let names: Names;
const enName: Record<string, Map<string, string>> = { species: new Map(), moves: new Map(), items: new Map(), abilities: new Map(), natures: new Map() };
const lookup: Record<string, Map<string, string>> = { species: new Map(), moves: new Map(), items: new Map(), abilities: new Map() };
function ja(kind: string, name: string): string {
  if (!name) return '';
  const id = toID(name);
  return (names as any)[kind]?.[id] ?? name;
}
/** 入力された日本語（または英語）から英語名を引く。見つからなければ ''。 */
function resolve(kind: string, text: string): string {
  const t = text.trim();
  if (!t) return '';
  const hit = lookup[kind].get(kata(t)) ?? lookup[kind].get(toID(t));
  return hit ?? '';
}

// ---- Showdown（Worker） ----
let speciesInfo = new Map<string, { name: string; baseStats: Record<StatID, number>; abilities: string[]; movepool: Set<string> }>();
let natureList: { id: string; name: string; plus: string; minus: string }[] = [];
let worker: Worker;
function call(msg: any): Promise<any> {
  return new Promise((res, rej) => {
    worker.onmessage = ev => ev.data.type === 'error' ? rej(new Error(ev.data.message)) : res(ev.data);
    worker.postMessage(msg);
  });
}
function info(species: string): MonInfo | undefined {
  const s = speciesInfo.get(toID(species));
  return s && { baseStats: s.baseStats, abilities: s.abilities, movepool: s.movepool };
}

// ---- 状態 ----
let parties: Party[] = load<Party[]>(KEY_PARTIES, []);
let current: Party;
let repoList: string[] = [];
let message = '';

function persistLocal() {
  current.updatedAt = new Date().toISOString();
  const i = parties.findIndex(p => p.id === current.id);
  if (i >= 0) parties[i] = current; else parties.push(current);
  store(KEY_PARTIES, parties);
  store(KEY_CURRENT, current.id);
}

// ---- 画面 ----
function esc(s: string) { return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)); }
function natureLabel(n: { name: string; plus: string; minus: string }) {
  const j = ja('natures', n.name);
  return n.plus ? `${j}（${STAT_JA[n.plus as StatID]}↑ ${STAT_JA[n.minus as StatID]}↓）` : `${j}（補正なし）`;
}

function render() {
  const token = getToken();
  const options = parties.map(p => `<option value="${p.id}" ${p.id === current.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  const repoOnly = repoList.filter(f => !parties.some(p => `${p.id}.json` === f));
  app.innerHTML = `
  <section class="box">
    <h2>合い鍵（GitHub）</h2>
    <p class="muted">保存のたびに、リポジトリの data/parties/ にも書き込むための合い鍵です。このブラウザの中にだけ保存し、リポジトリには入れません。</p>
    <p>${token ? `設定済み（末尾 ${esc(token.slice(-4))}）` : '未設定（保存はこのブラウザの中だけになります）'}</p>
    <p><input id="token" type="password" placeholder="github_pat_…" autocomplete="off" size="40"> <button id="token-save">合い鍵を保存</button> ${token ? '<button id="token-clear">合い鍵を消す</button>' : ''}</p>
  </section>
  <section class="box">
    <h2>パーティ</h2>
    <p><select id="party-select">${options}</select> <button id="party-new">新しく作る</button> <button id="party-delete">このパーティを消す</button></p>
    ${repoOnly.length ? `<p>リポジトリにあって、このブラウザにないパーティ：${repoOnly.map(f => `<button class="repo-load" data-file="${esc(f)}">${esc(f)} を読み込む</button>`).join(' ')}</p>` : ''}
    <p><label>パーティの名前 <input id="party-name" value="${esc(current.name)}"></label></p>
  </section>
  <div class="mons">${current.mons.map((m, i) => monCard(m, i)).join('')}</div>
  <section class="box">
    <div id="problems">${problemsHtml()}</div>
    <p><button id="save" class="primary">保存</button> <span id="msg">${esc(message)}</span></p>
  </section>
  <datalist id="dl-species">${[...speciesInfo.values()].map(s => `<option value="${esc(ja('species', s.name))}">`).join('')}</datalist>
  <datalist id="dl-items">${[...enName.items.values()].map(n => `<option value="${esc(ja('items', n))}">`).join('')}</datalist>`;
  bind();
}

function monCard(m: PartyMon, i: number) {
  const inf = speciesInfo.get(toID(m.species));
  const nat = natureList.find(n => n.name === m.nature) ?? natureList[0];
  const sum = STATS.reduce((a, s) => a + (m.evs[s] || 0), 0);
  const movepool = inf ? [...inf.movepool].map(id => enName.moves.get(id)).filter(Boolean) as string[] : [];
  return `<section class="box mon" data-slot="${i}">
    <h3>${i + 1}体目</h3>
    <p><label>ポケモン <input class="f-species" list="dl-species" value="${esc(ja('species', m.species))}"></label>
       <label>性別 <select class="f-gender"><option value="" ${!m.gender ? 'selected' : ''}>なし</option><option value="M" ${m.gender === 'M' ? 'selected' : ''}>♂</option><option value="F" ${m.gender === 'F' ? 'selected' : ''}>♀</option></select></label></p>
    <p><label>持ち物 <input class="f-item" list="dl-items" value="${esc(ja('items', m.item))}"></label></p>
    <p><label>特性 <select class="f-ability">${inf ? inf.abilities.map(a => `<option value="${esc(a)}" ${toID(a) === toID(m.ability) ? 'selected' : ''}>${esc(ja('abilities', a))}</option>`).join('') : '<option value="">（先にポケモンを入れてください）</option>'}</select></label></p>
    <p><label>性格 <select class="f-nature">${natureList.map(n => `<option value="${n.name}" ${n.name === m.nature ? 'selected' : ''}>${esc(natureLabel(n))}</option>`).join('')}</select></label></p>
    <table class="sp"><thead><tr><th></th><th>能力ポイント</th><th>実数値</th></tr></thead><tbody>
      ${STATS.map(s => `<tr><td>${STAT_JA[s]}${nat?.plus === s ? ' ↑' : nat?.minus === s ? ' ↓' : ''}</td>
        <td><input class="f-sp" data-stat="${s}" type="number" min="0" max="${SP_MAX}" value="${m.evs[s]}"></td>
        <td class="stat" data-stat="${s}">${inf ? calcStat(s, inf.baseStats[s], m.evs[s] || 0, nat?.plus, nat?.minus) : '－'}</td></tr>`).join('')}
    </tbody></table>
    <p class="${sum > SP_TOTAL ? 'warn' : 'muted'}">能力ポイントの合計：<span class="sp-sum">${sum}</span> / ${SP_TOTAL}</p>
    <datalist id="dl-moves-${i}">${movepool.map(n => `<option value="${esc(ja('moves', n))}">`).join('')}</datalist>
    ${[0, 1, 2, 3].map(k => `<p><label>技${k + 1} <input class="f-move" data-k="${k}" list="dl-moves-${i}" value="${esc(ja('moves', m.moves[k] ?? ''))}"></label></p>`).join('')}
  </section>`;
}

let showdownProblems: string[] = [];
function problemsHtml() {
  const ps = checkParty(current.mons, info, ja, toID);
  const lines = ps.map(p => `<li>${p.slot === null ? '' : `${p.slot + 1}体目：`}${esc(p.text)}</li>`);
  for (const t of showdownProblems) lines.push(`<li>Showdown の検査：${esc(t)}</li>`);
  return lines.length ? `<p class="warn">入力の確認：</p><ul class="warn">${lines.join('')}</ul>` : '<p>入力の確認：問題はありません。</p>';
}
function refreshProblems() { document.getElementById('problems')!.innerHTML = problemsHtml(); }

function bind() {
  document.getElementById('token-save')!.onclick = () => {
    const v = (document.getElementById('token') as HTMLInputElement).value.trim();
    if (!v) return;
    try { localStorage.setItem(KEY_TOKEN, v); } catch { /* 保存できない */ }
    message = '合い鍵を保存しました。'; render();
  };
  const clear = document.getElementById('token-clear');
  if (clear) clear.onclick = () => {
    if (!confirm('このブラウザから合い鍵を消しますか？（GitHub 側の合い鍵は消えません）')) return;
    try { localStorage.removeItem(KEY_TOKEN); } catch { /* */ }
    message = '合い鍵を消しました。'; render();
  };
  (document.getElementById('party-select') as HTMLSelectElement).onchange = e => {
    current = parties.find(p => p.id === (e.target as HTMLSelectElement).value)!;
    store(KEY_CURRENT, current.id); showdownProblems = []; message = ''; render();
  };
  document.getElementById('party-new')!.onclick = () => { current = newParty(); parties.push(current); showdownProblems = []; message = ''; render(); };
  document.getElementById('party-delete')!.onclick = () => {
    if (!confirm(`「${current.name}」をこのブラウザから消しますか？（リポジトリのファイルは消えません）`)) return;
    parties = parties.filter(p => p.id !== current.id); store(KEY_PARTIES, parties);
    current = parties[0] ?? newParty(); if (!parties.length) parties.push(current);
    message = '消しました。'; render();
  };
  document.querySelectorAll<HTMLButtonElement>('.repo-load').forEach(b => b.onclick = async () => {
    const p: Party = await (await fetch(`${base}data/parties/${b.dataset.file}`, { cache: 'no-store' })).json();
    parties.push(p); current = p; store(KEY_PARTIES, parties); message = 'リポジトリから読み込みました。'; render();
  });
  (document.getElementById('party-name') as HTMLInputElement).oninput = e => { current.name = (e.target as HTMLInputElement).value; };

  document.querySelectorAll<HTMLElement>('.mon').forEach(card => {
    const i = Number(card.dataset.slot);
    const m = current.mons[i];
    const q = <T extends HTMLElement>(sel: string) => card.querySelector<T>(sel)!;
    q<HTMLInputElement>('.f-species').onchange = e => {
      const v = resolve('species', (e.target as HTMLInputElement).value);
      const next = v || (e.target as HTMLInputElement).value.trim();
      if (next === m.species) return;
      m.species = next;
      const inf = speciesInfo.get(toID(m.species));
      if (inf && !inf.abilities.map(toID).includes(toID(m.ability))) m.ability = inf.abilities[0];
      rerenderCard(i);
    };
    q<HTMLSelectElement>('.f-gender').onchange = e => { m.gender = (e.target as HTMLSelectElement).value as any; };
    q<HTMLInputElement>('.f-item').onchange = e => { const t = (e.target as HTMLInputElement).value; m.item = resolve('items', t) || t.trim(); refreshProblems(); };
    q<HTMLSelectElement>('.f-ability').onchange = e => { m.ability = (e.target as HTMLSelectElement).value; refreshProblems(); };
    q<HTMLSelectElement>('.f-nature').onchange = e => { const v = (e.target as HTMLSelectElement).value; if (v === m.nature) return; m.nature = v; rerenderCard(i); };
    card.querySelectorAll<HTMLInputElement>('.f-sp').forEach(inp => inp.oninput = () => {
      m.evs[inp.dataset.stat as StatID] = Number(inp.value || 0);
      updateStats(i); refreshProblems();
    });
    card.querySelectorAll<HTMLInputElement>('.f-move').forEach(inp => inp.onchange = () => {
      const t = inp.value; m.moves[Number(inp.dataset.k)] = resolve('moves', t) || t.trim(); refreshProblems();
    });
  });
  document.getElementById('save')!.onclick = save;
}

// 作り直しの最中に、外した入力欄の blur から change がもう一度来ても何もしない
let rerendering = false;
function rerenderCard(i: number) {
  if (rerendering) return;
  const old = document.querySelector(`.mon[data-slot="${i}"]`);
  if (!old || !old.parentNode) return;
  rerendering = true;
  try {
    const tmp = document.createElement('div'); tmp.innerHTML = monCard(current.mons[i], i);
    old.replaceWith(tmp.firstElementChild!);
  } finally { rerendering = false; }
  bind(); refreshProblems();
}
function updateStats(i: number) {
  const m = current.mons[i]; const inf = speciesInfo.get(toID(m.species));
  const nat = natureList.find(n => n.name === m.nature);
  const card = document.querySelector(`.mon[data-slot="${i}"]`)!;
  for (const s of STATS) card.querySelector(`.stat[data-stat="${s}"]`)!.textContent = inf ? String(calcStat(s, inf.baseStats[s], m.evs[s] || 0, nat?.plus, nat?.minus)) : '－';
  const sum = STATS.reduce((a, s) => a + (m.evs[s] || 0), 0);
  card.querySelector('.sp-sum')!.textContent = String(sum);
}

async function save() {
  const btn = document.getElementById('save') as HTMLButtonElement;
  btn.disabled = true;
  try {
    current.name = (document.getElementById('party-name') as HTMLInputElement).value || '名前なし';
    persistLocal();
    const v = await call({ type: 'validate', mons: current.mons.filter(m => m.species) });
    // Showdown の検査のうち、日本語の検査と重ならないものだけを足す
    showdownProblems = checkParty(current.mons, info, ja, toID).length ? [] : v.problems;
    const token = getToken();
    if (!token) { message = 'このブラウザに保存しました（合い鍵がないので、リポジトリには書き込んでいません）。'; render(); return; }
    message = 'このブラウザに保存しました。リポジトリに書き込み中…'; render();
    const body = JSON.stringify({ id: current.id, name: current.name, updatedAt: current.updatedAt, mons: current.mons }, null, 1) + '\n';
    await putFile(token, `data/parties/${current.id}.json`, body, `パーティを保存：${current.name}`);
    message = 'このブラウザとリポジトリに保存しました。'; render();
  } catch (e: any) {
    message = `このブラウザには保存しました。リポジトリへの書き込みは失敗しました：${e.message}`; render();
  } finally { (document.getElementById('save') as HTMLButtonElement | null)?.removeAttribute('disabled'); }
}

async function main() {
  worker = new Worker(new URL('../engine/browser/party-worker.ts', import.meta.url), { type: 'module' });
  const [n, init] = await Promise.all([
    fetch(`${base}data/names/ja.json`).then(r => r.json()),
    call({ type: 'init' }),
  ]);
  names = n;
  for (const s of init.species) speciesInfo.set(s.id, { name: s.name, baseStats: s.baseStats, abilities: s.abilities, movepool: new Set(s.movepool) });
  natureList = init.natures.sort((a: any, b: any) => (a.plus ? 1 : 0) - (b.plus ? 1 : 0) || a.id.localeCompare(b.id));
  for (const [kind, list] of [['species', init.species], ['moves', init.moves], ['items', init.items], ['abilities', init.abilities]] as const) {
    for (const x of list as any[]) {
      enName[kind].set(x.id, x.name);
      lookup[kind].set(x.id, x.name);
      const j = (names as any)[kind]?.[x.id];
      if (j) lookup[kind].set(kata(j), x.name);
      if (kind === 'species') for (const a of names.speciesAliases?.[x.id] ?? []) lookup.species.set(kata(a), x.name);
    }
  }
  try { repoList = (await (await fetch(`${base}data/parties/index.json`, { cache: 'no-store' })).json()).files ?? []; } catch { repoList = []; }
  if (!parties.length) parties.push(newParty());
  const cur = load<string>(KEY_CURRENT, '');
  current = parties.find(p => p.id === cur) ?? parties[0];
  for (const p of parties) while (p.mons.length < 6) p.mons.push(emptyMon());
  render();
}
main().catch(e => { app.innerHTML = `<p>エラー：${esc(String(e?.message ?? e))}</p>`; });
