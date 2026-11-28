// 対戦中の画面：準備 → 毎ターンの入力 → 記録係（Worker）で盤面と推定を更新 → 探索（Worker を並べて10秒）で上位3手。
// 対戦の記録はブラウザに保存し、ページを開き直しても記録から当て直して戻る。終えたら data/logs/ にも書く（合い鍵があれば）。
import dexJson from '../engine/data/dex.json';
import type { BattleSetup, TurnInput, StartInput, VisibleState, ReplaceInput } from '../battle/analyze.ts';
import type { Position, StatusID, MonSet } from '../engine/position.ts';
import { SearchPool } from '../search/coordinator.ts';
import { putFile } from '../party/github.ts';
import { spotSolve } from '../select/spot.ts';
import { emptyStats, solveTable, allowedRows, type TableStats } from '../select/table.ts';
import { pickOf } from '../select/cell.ts';
import { partyKey, plainSet } from '../select/key.ts';
import { predictCell } from '../select/model.ts';
import { likelySet } from '../select/likely.ts';
import { mergePriors } from '../learn/merge.ts';
import { DEFAULT_SETTINGS, type SearchSettings } from '../learn/decide.ts';

const base = import.meta.env.BASE_URL;
const app = document.getElementById('app')!;
const KEY_BATTLE = 'champions.currentBattle', KEY_PARTIES = 'champions.parties', KEY_TOKEN = 'champions.githubToken', KEY_TIME = 'champions.searchMs', KEY_SELECT_TIME = 'champions.selectMs';
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
// 探索の設定（AIどうしの比べで採用したもの。data/learn/settings.json。読めなければ最初の設定）
let searchSettings: SearchSettings = { ...DEFAULT_SETTINGS };
let searching = false;
let message = '';

// ---- Worker ----
const analysis = new Worker(new URL('../engine/browser/analysis-worker.ts', import.meta.url), { type: 'module' });
// 記録係への問い合わせは1つずつ順番に（同時に2つ送ると、返事を取り違えるため）
let askChain: Promise<unknown> = Promise.resolve();
function ask(msg: any): Promise<any> {
  const p = askChain.then(() => new Promise((res, rej) => { analysis.onmessage = ev => ev.data.type === 'error' ? rej(new Error(ev.data.message)) : res(ev.data); analysis.postMessage(msg); }));
  askChain = p.catch(() => undefined);
  return p;
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
    <h3>相手の6匹</h3>
    <div class="row">${[0, 1, 2, 3, 4, 5].map(i => `<input class="s-opp" data-i="${i}" list="dl-species" placeholder="${i + 1}匹目" size="12">`).join(' ')}</div>
    <datalist id="dl-species">${Object.entries(ja.species).map(([, v]) => `<option value="${esc(v as string)}">`).join('')}</datalist>
    <h3>選出のおすすめ</h3>
    <div id="s-select" class="muted">（こちらのパーティと相手の6匹を入れると、読み合いで釣り合う選出を計算します）</div>
    <p class="muted"><label>その場で計算する時間 <input id="s-time" type="number" min="0" max="85" value="${Math.round(selectBudget() / 1000)}" style="width:4em">秒</label>（保存した表がない相手のとき、その場の試合で補う時間。0ならすぐに出す）</p>
    <h3>相手の先発</h3>
    <div id="s-opplead" class="row muted">（相手の6匹を入れると選べます）</div>
    <p><label>先発の特性の発動（出たとき） <select id="s-oppab"><option value="">なし</option></select></label>
       <label>先発の持ち物の発動（ふうせん等） <input id="s-oppitem" list="dl-items" size="12"></label></p>
    <datalist id="dl-items">${Object.values(ja.items).map(v => `<option value="${esc(v as string)}">`).join('')}</datalist>
    <p><button id="s-start" class="primary">対戦を始める</button> <span class="warn" id="s-msg"></span></p>
  </section>`;
  const renderOurs = () => {
    const p = parties[Number((document.getElementById('s-party') as HTMLSelectElement).value)];
    document.getElementById('s-ours')!.innerHTML = p ? `<h3>こちらの選出（3匹を選び、先発を1匹選ぶ）</h3><table><tr><th>選ぶ</th><th>先発</th><th>ポケモン</th></tr>${p.mons.map((m: any, i: number) =>
      `<tr><td><input type="checkbox" class="s-pick" data-i="${i}"></td><td><input type="radio" name="s-lead" value="${i}"></td><td>${esc(jn('species', m.species))}</td></tr>`).join('')}</table>` : '';
  };
  const oppIds = () => [...document.querySelectorAll<HTMLInputElement>('.s-opp')].map(x => resolve('species', x.value));
  const trySelect = () => { const p = parties[Number((document.getElementById('s-party') as HTMLSelectElement).value)]; const ids = oppIds(); if (p && ids.every(Boolean)) computeSelection(p, ids).catch(e => { const el = document.getElementById('s-select'); if (el) el.innerHTML = `<p class="warn">選出を計算できませんでした：${esc(String(e?.message ?? e))}。3匹と先発は自分で選んでください。</p>`; }); };
  (document.getElementById('s-party') as HTMLSelectElement).onchange = () => { renderOurs(); lastIds = ''; renderLead(); };
  renderOurs();
  (document.getElementById('s-time') as HTMLInputElement).onchange = e => store(KEY_SELECT_TIME, Math.max(0, Math.min(85, Number((e.target as HTMLInputElement).value))) * 1000);
  // 6匹の名前が変わったときだけ作り直す（入力欄の確定の後で押した先発のボタンが消えないように）
  let lastIds = '';
  const renderLead = () => {
    const ids = oppIds();
    if (ids.join(',') === lastIds) return;
    lastIds = ids.join(',');
    trySelect();
    document.getElementById('s-opplead')!.innerHTML = ids.every(Boolean) ? ids.map((id, i) => `<label><input type="radio" name="s-opplead" value="${i}"> ${esc(jn('species', id))}</label>`).join(' ') : '（相手の6匹を入れると選べます）';
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
    if (picks.length !== 3) { msgEl.textContent = 'こちらの3匹を選んでください。'; return; }
    if (!picks.includes(lead)) { msgEl.textContent = '先発は、選んだ3匹の中から選んでください。'; return; }
    if (!ids.every(Boolean)) { msgEl.textContent = `相手の${ids.findIndex(x => !x) + 1}匹目の名前が分かりません。候補から選んでください。`; return; }
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
    // 選出の計算をやめ、その Worker を片づける（対戦中の探索に計算機を回す）
    selectGen++; selectWorkers?.forEach(w => w.terminate()); selectWorkers = null;
    await refresh();
  };
}

// ---- 選出のおすすめ ----
/** その場の試合で補う時間（既定0秒＝すぐに出す。i5-5300 では45秒でも約30試合で、おすすめがほとんど変わらないため。前の既定60秒が保存されていれば0にする） */
function selectBudget(): number { const v = load<number>(KEY_SELECT_TIME, 0); return v === 60000 ? 0 : v; }
let selectGen = 0;
let selectWorkers: Worker[] | null = null;
let selectReady: Promise<void> | null = null;
async function fetchJson(url: string): Promise<any> { try { const r = await fetch(url, { cache: 'no-cache' }); return r.ok ? await r.json() : null; } catch { return null; } }
function getSelectWorkers() {
  if (!selectWorkers) {
    selectWorkers = Array.from({ length: Math.max(2, navigator.hardwareConcurrency || 2) }, () => new Worker(new URL('../engine/browser/select-worker.ts', import.meta.url), { type: 'module' }));
    selectReady = Promise.all(selectWorkers.map(w => new Promise<void>(res => { w.onmessage = ev => { if (ev.data.type === 'ready') res(); }; }))).then(() => undefined);
  }
  return { workers: selectWorkers, ready: selectReady! };
}

/** 相手の6匹が決まったら：保存した表を読む。なければ近い構築からの見積もりと、その場の試合で補う。結果を出し、確率どおりにくじを引いて準備欄に入れる。 */
async function computeSelection(p: any, ids: string[]) {
  const tStart = performance.now();
  const gen = ++selectGen;
  const el = document.getElementById('s-select');
  if (!el) return;
  el.className = '';
  el.innerHTML = '<p>選出を計算しています…</p>';
  const key = partyKey(p.mons);
  const ours = p.mons.map(plainSet);
  const index = await fetchJson(`${base}data/precomputed/index.json`);
  const sorted = [...ids].sort().join(',');
  // 同じ6匹の表が複数のシーズンにあれば、新しいシーズンのものを使う
  const seasonNo = (x: string) => Number(String(x ?? '').replace(/\D/g, '')) || 0;
  const entry = (index?.tables ?? []).filter((t: any) => t.party === p.id && t.partyKey === key && t.species.map(toID).sort().join(',') === sorted && t.games > 0)
    .sort((a: any, b: any) => seasonNo(b.season) - seasonNo(a.season))[0];
  const basis: string[] = [];
  let stats: TableStats = emptyStats(), species: string[] = ids, theirs: any[] = [];
  if (entry) {
    const saved = await fetchJson(`${base}data/precomputed/${entry.file}`);
    if (saved) {
      stats = { n: saved.n, w: saved.w }; species = saved.team.species;
      basis.push(`保存した表（${saved.team.season} ${saved.team.rank}位の構築、${saved.games}試合${saved.done ? '' : '、まだ途中'}）`);
    }
  }
  const model = await fetchJson(`${base}data/precomputed/${p.id}/model.json`);
  const prior = model && model.partyKey === key && model.tables > 0 ? (k: number) => predictCell(model, species, k) : undefined;
  if (gen !== selectGen) return;
  // こちらが選べる選び方：メガストーンを持つポケモンがちょうど1匹の組だけ（いなければ全部）
  const allowed = allowedRows(i => !!dex.items[toID(p.mons[i]?.item ?? '')]?.megaStone);
  let sol, games = 0, ms = 0;
  if (basis.length) {
    sol = solveTable(stats, prior, 0.01, allowed);
  } else {
    const priors = mergePriors(await fetchJson(`${base}data/priors/sets.json`), await fetchJson(`${base}data/priors/learned.json`));
    theirs = ids.map(id => likelySet(priors?.species?.[id]));
    if (theirs.some(x => !x)) { el.innerHTML = `<p class="warn">型の候補がない相手がいるため、選出を計算できません：${esc(ids.filter((_, i) => !theirs[i]).map(id => jn('species', id)).join('、'))}</p>`; return; }
    basis.push(prior ? `近い構築からの見積もり（保存した表 ${model.tables}個・${model.games}試合から作った相性）` : '保存した表も近い構築の結果もありません（確率はあてになりません）');
    if (selectBudget() <= 0) { sol = solveTable(stats, prior, 0.01, allowed); }
    else {
    const { workers, ready } = getSelectWorkers();
    await ready;
    const free = [...workers];
    const waiting: ((w: Worker) => void)[] = [];
    const acquire = () => new Promise<Worker>(res => { const w = free.pop(); if (w) res(w); else waiting.push(res); });
    const release = (w: Worker) => { const f = waiting.shift(); if (f) f(w); else free.push(w); };
    const play = async (r: number, c: number, seed: number) => {
      const w = await acquire();
      try {
        return await new Promise<number>((res, rej) => { w.onmessage = ev => ev.data.type === 'game' ? res(ev.data.v) : rej(new Error(ev.data.message)); w.postMessage({ ours, theirs, r, c, iters: 100, seed }); });
      } finally { release(w); }
    };
    // 6匹を入れ終えた時点（computeSelection の始め）から数えて、決めた時間（既定45秒）の中に収める。
    // 打ちかけの試合が締め切りの後に終わる分（i5-5300 で1試合数秒の見込み）として3秒残す
    const timeMs = Math.max(3000, selectBudget() - (performance.now() - tStart) - 3000);
    el.innerHTML = `<p>選出を計算しています…（その場の試合：<span id="s-prog">0</span>、最大${Math.round(timeMs / 1000)}秒）</p>`;
    const r = await spotSolve({ stats, prior, timeMs, workers: workers.length, play, allowed, cancelled: () => gen !== selectGen,
      onProgress: g => { const pe = document.getElementById('s-prog'); if (pe && gen === selectGen) pe.textContent = String(g); } });
    sol = r.sol; games = r.games; ms = r.ms;
    if (games) basis.push(`その場の試合 ${games}（${(ms / 1000).toFixed(0)}秒）`);
    }
  }
  if (gen !== selectGen || !document.getElementById('s-select')) return;
  if (allowed) basis.push('こちらは、メガストーンを持つポケモンがちょうど1匹の組だけから選ぶ');
  // こちらの確率の高い順。くじは確率どおりに引く
  const rows = sol.row.map((x: number, i: number) => ({ i, x })).filter((r: any) => r.x >= 0.005).sort((a: any, b: any) => b.x - a.x);
  const name = (k: number) => { const pk = pickOf(k); return pk.order.map((i, n) => esc(jn('species', p.mons[i].species)) + (n === 0 ? '（先発）' : '')).join('・'); };
  let u = Math.random() * rows.reduce((a: number, r: any) => a + r.x, 0), pick = rows[0].i;
  for (const r of rows) { u -= r.x; if (u <= 0) { pick = r.i; break; } }
  const pk = pickOf(pick);
  document.querySelectorAll<HTMLInputElement>('.s-pick').forEach(x => { x.checked = pk.trio.includes(Number(x.dataset.i)); });
  document.querySelectorAll<HTMLInputElement>('input[name="s-lead"]').forEach(x => { x.checked = Number(x.value) === pk.lead; });
  el.innerHTML = `<p><strong>くじの結果：${name(pick)}</strong>（準備欄に入れました。選び直してもかまいません）</p>
    <table><tr><th>選出（3匹）</th><th>確率</th></tr>${rows.map((r: any) => `<tr${r.i === pick ? ' class="hl"' : ''}><td>${name(r.i)}</td><td>${Math.round(r.x * 100)}%</td></tr>`).join('')}</table>
    <p class="muted">釣り合いの勝率 ${Math.round(sol.value * 100)}%（相手がこちらの確率を読んで一番よい選出をしても、この勝率が見込める）。もとにしたもの：${basis.map(esc).join('、')}。</p>`;
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
  // 相手がメガシンカしうるのは、まだメガシンカしていなくて、場のポケモンの種族にメガストーンがあるとき
  const oppSpId = toID(doc!.setup.oppSpecies[oaIdx]);
  const canMegaOpp = !them.megaUsed && !oaMon.mega && Object.values(dex.items).some((it: any) => it.megaStone && Object.keys(it.megaStone).some((k: string) => toID(k) === oppSpId || toID(k) === toID(dex.species[oppSpId]?.baseSpecies ?? '')));
  const oppAlive = view.opp.map((o: any, i: number) => ({ o, i })).filter((x: any) => !x.o.fainted);
  const top = result?.top ?? [];
  const pend: number[] = view.pending ?? [];
  const ourAlive = us.mons.filter((m: any) => m.hp > 0).length, oppFaintedN = view.opp.filter((o: any) => o.fainted).length;
  const ended = ourAlive === 0 || oppFaintedN >= 3;
  // 相手の技のボタン：見えた技を先に、続いて推定で多い技（合わせて最大6つ）
  const oppMoveBtns = [...new Set([...(sum?.revealed ?? []).map(toID), ...(sum?.moves ?? []).map((x: any) => toID(x.name))])].slice(0, 6);
  const revealedSet = new Set((sum?.revealed ?? []).map(toID));
  app.innerHTML = `
  <section class="box"><h2>ターン ${view.turn + 1}</h2>
    <p><strong>こちら</strong>：${esc(jn('species', ua.set.species))} HP ${ua.hp}/${maxhp(ua.set)} ${STATUS_JA[ua.status] !== 'なし' ? STATUS_JA[ua.status] : ''} ${esc(boostsText(ua.boosts))}
      ／ 控え：${us.mons.map((m: MonSet & any, i: number) => i === us.active ? '' : `${esc(jn('species', m.set.species))} ${m.hp}/${maxhp(m.set)}`).filter(Boolean).join('、')}</p>
    <p><strong>相手</strong>：${esc(jn('species', view.pos.sides[1].mons[them.active].set.species))} HP ${oa.hpPct}% ${STATUS_JA[oa.status] !== 'なし' ? STATUS_JA[oa.status] : ''} ${esc(boostsText(oaMon.boosts))}
      ／ 見えたポケモン：${view.opp.map((o: any, i: number) => o.seen ? `${esc(jn('species', doc!.setup.oppSpecies[i]))}${o.fainted ? '（ひんし）' : ` ${o.hpPct}%`}` : '').filter(Boolean).join('、')}</p>
    ${view.notes.length ? `<p class="warn">${view.notes.map(esc).join('<br>')}</p>` : ''}
  </section>
  <section class="box"><h2>おすすめ（上位3手）</h2>
    <div id="result">${searching ? '<p>計算中…</p>' : top.length ? `<table class="big-table"><tr><th></th><th>行動</th><th>勝率</th><th>誤差</th></tr>${top.map((t: any, i: number) =>
      `<tr><td>${i + 1}</td><td><strong>${esc(choiceLabel(t.choice))}</strong></td><td>${Math.round(t.winRate * 100)}%</td><td>±${Math.round(2 * t.se * 100)}</td></tr>`).join('')}</table>
      ${top.some((t: any) => t.closeToNext) ? '<p class="warn">勝率の差が誤差より小さい手があります（どちらを選んでも大きくは変わらない見込み）。</p>' : ''}
      <p class="muted" id="r-time">再現 ${(result.prepMs / 1000).toFixed(1)}秒＋探索 ${(result.ms / 1000).toFixed(1)}秒（${result.iters}回）＝合計 ${(result.totalMs / 1000).toFixed(1)}秒</p>
      ${result.totalMs > result.budget + 50 ? `<p class="warn">合計が計算時間（${(result.budget / 1000).toFixed(0)}秒）を超えました。</p>` : ''}` : '<p class="muted">まだ計算していません。</p>'}
    </div>
  </section>
  ${ended ? `<section class="box"><h2>対戦が終わりました（${ourAlive === 0 ? '負け' : '勝ち'}）</h2>
    <p>${ourAlive === 0 ? 'こちらの3匹がすべて倒れました。' : '相手の3匹がすべて倒れました。'}記録を保存するか、保存せずに終えてください。</p>
    <p><button id="b-end2" class="primary big">対戦を終える（記録を保存）</button> <button id="b-discard2" class="big">保存せずに終える</button></p></section>`
  : pend.length ? `<section class="box turn"><h2>死に出し（倒れたポケモンの交代先）</h2>
    <p class="muted">おすすめ（上）は、出すポケモンごとの勝率です。出したポケモンを押してください。</p>
    ${pend.includes(0) ? `<h3>こちらが出すポケモン</h3><div class="choices">${us.mons.map((m: any, i: number) => m.hp > 0 ? `<label class="btn big"><input type="radio" name="r-our" value="${i}"> ${esc(jn('species', m.set.species))}</label>` : '').join('')}</div>` : ''}
    ${pend.includes(1) ? `<h3>相手が出したポケモン</h3><div class="choices">${view.opp.map((o: any, i: number) => !o.fainted && i !== oaIdx ? `<label class="btn big"><input type="radio" name="r-opp" value="${i}"> ${esc(jn('species', doc!.setup.oppSpecies[i]))}</label>` : '').join('')}</div>` : ''}
    <div id="r-result" hidden>
      <h3>出てきた後のHP <span class="muted" id="r-predmsg"></span></h3>
      <div class="hps">
        ${pend.includes(1) ? `<div class="hp"><span id="r-oppname">相手</span><span><input id="r-opphp" class="big num" type="number" inputmode="numeric" min="0" max="100" value="100"> %</span></div>` : ''}
        ${us.mons.map((m: any, i: number) => m.hp > 0 ? `<div class="hp"><span>${esc(jn('species', m.set.species))}</span><span><input class="r-ourhp big num" data-i="${i}" type="number" inputmode="numeric" min="0" max="${maxhp(m.set)}" value="${m.hp}"> /${maxhp(m.set)}</span></div>` : '').join('')}
      </div>
      ${pend.includes(1) ? `<details><summary>相手の特性・持ち物の発動（出たとき。あったときだけ）</summary><p>特性 <input id="r-oppab" list="dl-ab2" placeholder="なし"><datalist id="dl-ab2">${Object.values(ja.abilities).map(v => `<option value="${esc(v as string)}">`).join('')}</datalist> 持ち物 <input id="r-oppitem" list="dl-items4" placeholder="なし"><datalist id="dl-items4">${Object.values(ja.items).map(v => `<option value="${esc(v as string)}">`).join('')}</datalist></p></details>` : ''}
    </div>
    <p><button id="r-record" class="primary big">出して計算</button> <span class="warn" id="r-msg"></span></p></section>`
  : `<section class="box turn"><h2>このターンに起きたこと</h2>
    <h3>① 相手の行動</h3>
    <div class="choices">${oppMoveBtns.map(m => `<label class="btn big"><input type="radio" name="t-opp" value="move ${esc(m)}"> ${esc(jn('moves', m))}${revealedSet.has(m) ? '' : '<small>（推定）</small>'}</label>`).join('')}
      ${oppAlive.filter((x: any) => x.i !== oaIdx).map((x: any) => `<label class="btn big"><input type="radio" name="t-opp" value="switch ${x.i}"> 交代→${esc(jn('species', doc!.setup.oppSpecies[x.i]))}</label>`).join('')}
      <label class="btn big"><input type="radio" name="t-opp" value="none"> 動けなかった</label>
      <label class="btn big"><input type="radio" name="t-opp" value="other"> ほかの技</label></div>
    <p id="row-othermove" hidden><input id="t-oppmove" class="big" list="dl-oppmoves" placeholder="技の名前"><datalist id="dl-oppmoves">${Object.values(ja.moves).map(v => `<option value="${esc(v as string)}">`).join('')}</datalist></p>
    ${canMegaOpp ? '<p><label class="btn"><input type="checkbox" id="t-oppmega"> 相手がメガシンカした</label></p>' : ''}
    <h3>② こちらの行動</h3>
    <div class="choices">${ua.set.moves.map((m: string, k: number) => `<label class="btn big"><input type="radio" name="t-our" value="move ${k}"> ${esc(jn('moves', m))}</label>`).join('')}
      ${us.mons.map((m: any, i: number) => i !== us.active && m.hp > 0 ? `<label class="btn big"><input type="radio" name="t-our" value="switch ${i}"> 交代→${esc(jn('species', m.set.species))}</label>` : '').join('')}
      <label class="btn big"><input type="radio" name="t-our" value="none"> 動けなかった</label></div>
    ${canMegaUs ? '<p><label class="btn"><input type="checkbox" id="t-ourmega"> メガシンカした</label></p>' : ''}
    <div id="row-pivot" hidden><h3>交代先（交代技で出したポケモン）</h3>
      <div class="choices">${us.mons.map((m: any, i: number) => i !== us.active && m.hp > 0 ? `<label class="btn big"><input type="radio" name="t-pivot" value="${i}"> ${esc(jn('species', m.set.species))}</label>` : '').join('')}</div></div>
    <div id="t-result" hidden>
    <h3>③ 結果 <span class="muted" id="t-predmsg"></span></h3>
    <p id="row-first" hidden><strong>先に動いた</strong>：<label class="btn big"><input type="radio" name="t-first" value="us"> こちら</label><label class="btn big"><input type="radio" name="t-first" value="them"> 相手</label></p>
    <div class="hps">
      <div class="hp"><span>相手の場のポケモン</span><select id="t-oppactive" class="big">${oppAlive.map((x: any) => `<option value="${x.i}" ${x.i === oaIdx ? 'selected' : ''}>${esc(jn('species', doc!.setup.oppSpecies[x.i]))}</option>`).join('')}</select><span><input id="t-opphp" class="big num" type="number" inputmode="numeric" min="0" max="100" value="${oa.hpPct}"> %</span></div>
      <div class="hp" id="opp-other-wrap"></div>
      <div class="hp"><span>こちらの場のポケモン</span><select id="t-ouractive" class="big">${us.mons.map((m: any, i: number) => `<option value="${i}" ${i === us.active ? 'selected' : ''}>${esc(jn('species', m.set.species))}</option>`).join('')}</select></div>
      ${[us.active, ...us.mons.map((_: any, i: number) => i).filter((i: number) => i !== us.active)].map((i: number) => { const m = us.mons[i]; return `<div class="hp"><span class="t-ourname" data-i="${i}">${esc(jn('species', m.set.species))}</span><span><input class="t-ourhp big num" data-i="${i}" type="number" inputmode="numeric" min="0" max="${maxhp(m.set)}" value="${m.hp}"> /${maxhp(m.set)}</span></div>`; }).join('')}
    </div>
    <p>状態異常：こちらの場のポケモン <select id="t-ourstatus" class="big">${Object.entries(STATUS_JA).map(([k, v]) => `<option value="${k}" ${k === (ua.status || '') ? 'selected' : ''}>${v}</option>`).join('')}</select>
      相手の場のポケモン <select id="t-oppstatus" class="big">${Object.entries(STATUS_JA).map(([k, v]) => `<option value="${k}" ${k === (oa.status || '') ? 'selected' : ''}>${v}</option>`).join('')}</select></p>
    <details><summary>ほかに起きたこと（急所・持ち物や特性の発動。あったときだけ）</summary>
    <p><strong>急所</strong>：<label class="btn"><input type="checkbox" id="t-critopp"> こちらの攻撃が急所</label> <label class="btn"><input type="checkbox" id="t-critus"> 相手の攻撃が急所</label>
      <span class="muted">（入れなければ「分からない」として計算します）</span></p>
    <p><strong>相手の持ち物の発動</strong> <input id="t-oppitem" list="dl-items2" placeholder="なし">
       <datalist id="dl-items2">${(sum?.items ?? []).map((x: any) => `<option value="${esc(jn('items', x.name))}">`).join('')}${Object.values(ja.items).map(v => `<option value="${esc(v as string)}">`).join('')}</datalist>
       <strong>相手の特性の発動</strong> <input id="t-oppab" list="dl-ab" placeholder="なし"><datalist id="dl-ab">${Object.values(ja.abilities).map(v => `<option value="${esc(v as string)}">`).join('')}</datalist></p>
    </details>
    </div>
    <p><button id="t-record" class="primary big">記録して計算</button> <span class="warn" id="t-msg"></span></p>
  </section>`}
  <section class="box"><h2>相手の型の推定（${esc(jn('species', doc!.setup.oppSpecies[oaIdx]))}）</h2>
    ${sum ? `<p>持ち物：${sum.items.map((x: any) => `${esc(jn('items', x.name))} ${Math.round(x.p * 100)}%`).join('、')}</p>
    <p>特性：${sum.abilities.map((x: any) => `${esc(jn('abilities', x.name))} ${Math.round(x.p * 100)}%`).join('、')}</p>
    <p>技：${sum.moves.map((x: any) => `${esc(jn('moves', x.name))} ${Math.round(x.p * 100)}%`).join('、')}</p>
    ${sum.ok ? '' : '<p class="warn">どの型の候補とも合いません。入力を確かめてください。</p>'}` : ''}
  </section>
  <details class="box"><summary>今の状態（能力ランク・天気・まきびし等。画面と違うときだけ直す）</summary>${stateForm()}
    <p><button id="v-apply">状態を直して計算</button></p></details>
  <section class="box"><h2>記録</h2>
    <p class="muted">${esc(doc!.partyName)}、${doc!.turns.length} ターン記録済み。</p>
    <p><button id="b-search">計算し直す</button> <label class="muted">計算時間 <input id="b-time" type="number" min="2" max="40" value="${Math.round(load<number>(KEY_TIME, 10000) / 1000)}" style="width:4em">秒</label></p>
    <p><button id="b-undo">1ターン取り消す</button> <button id="b-end">対戦を終える（記録を保存）</button> <button id="b-discard">保存せずに終える</button> <span>${esc(message)}</span></p>
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
  const volRow = (si: number, mon: any) => `<label><input type="checkbox" class="v-vol" data-s="${si}" data-k="leechseed" ${mon.vol?.leechseed ? 'checked' : ''}> やどりぎのタネ</label> <label><input type="checkbox" class="v-vol" data-s="${si}" data-k="substitute" ${mon.vol?.substitute ? 'checked' : ''}> みがわり</label>`;
  const ua = us.mons[us.active];
  const curItem = ua.itemGone ? '' : (ua.heldItem ?? ua.set.item);
  return `<p>こちらの場の持ち物 <input id="v-ouritem" list="dl-items3" size="12" value="${esc(curItem ? jn('items', curItem) : '')}" placeholder="なし"><datalist id="dl-items3">${Object.values(ja.items).map(v => `<option value="${esc(v as string)}">`).join('')}</datalist></p>
    <p>こちらの能力ランク：${boostRow(0, us.mons[us.active])} ${volRow(0, us.mons[us.active])}</p>
    <p>相手の能力ランク：${boostRow(1, them.mons[them.active])} ${volRow(1, them.mons[them.active])}</p>
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
  const vol: [any, any] = [{}, {}];
  document.querySelectorAll<HTMLInputElement>('.v-vol').forEach(x => { vol[Number(x.dataset.s)][x.dataset.k!] = x.checked; });
  const itemText = (document.getElementById('v-ouritem') as HTMLInputElement).value;
  const ourItem = itemText ? resolve('items', itemText) : '';
  return { boosts, cond, vol, ourItem: itemText && !ourItem ? undefined : ourItem, weather: (document.getElementById('v-weather') as HTMLSelectElement).value, terrain: (document.getElementById('v-terrain') as HTMLSelectElement).value, trickroom: (document.getElementById('v-tr') as HTMLInputElement).checked };
}

function bindBattle() {
  document.getElementById('b-search')!.onclick = () => runSearch();
  (document.getElementById('b-time') as HTMLInputElement).onchange = e => store(KEY_TIME, Math.max(2, Math.min(40, Number((e.target as HTMLInputElement).value))) * 1000);
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
  document.getElementById('b-discard')!.onclick = () => {
    if (!confirm('この対戦の記録を保存せずに消して、準備の画面に戻りますか？（元に戻せません）')) return;
    try { localStorage.removeItem(KEY_BATTLE); } catch { /* */ }
    doc = null; view = null; result = null; renderSetup();
    app.insertAdjacentHTML('afterbegin', '<p>対戦の記録を保存せずに終えました。</p>');
  };
  const radio = (name: string) => (document.querySelector(`input[name="${name}"]:checked`) as HTMLInputElement | null)?.value ?? '';
  if (document.getElementById('t-record')) bindTurn(radio);
  if (document.getElementById('r-record')) bindReplace(radio);
  const end2 = document.getElementById('b-end2'), discard2 = document.getElementById('b-discard2');
  if (end2) end2.onclick = () => (document.getElementById('b-end') as HTMLButtonElement).click();
  if (discard2) discard2.onclick = () => (document.getElementById('b-discard') as HTMLButtonElement).click();
  document.getElementById('b-end')!.onclick = async () => {
    if (!confirm('対戦を終えて、記録を保存しますか？（この画面の記録は消え、準備の画面に戻ります）')) return;
    const usNow = ourSide(), ourAliveNow = usNow.mons.filter((m: any) => m.hp > 0).length, oppDown = view.opp.filter((o: any) => o.fainted).length;
    const outcome = ourAliveNow === 0 ? '負け' : oppDown >= 3 ? '勝ち' : (prompt('結果を入れてください（勝ち／負け）', '') ?? '');
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

/** ターンの入力の動き：行動に合わせて場のポケモンをそろえ、結果を予想して入れる。手で直した欄は上書きしない。 */
function bindTurn(radio: (n: string) => string) {
  const us = ourSide();
  const startOpp = oppActiveIdx();
  const selOur = document.getElementById('t-ouractive') as HTMLSelectElement, selOpp = document.getElementById('t-oppactive') as HTMLSelectElement;
  const oppHp = document.getElementById('t-opphp') as HTMLInputElement;
  const hpOf = (i: number) => Number((document.querySelector(`.t-ourhp[data-i="${i}"]`) as HTMLInputElement).value);
  let pred: any = null;
  const otherVals = new Map<number, { v: string; touched: boolean }>();
  // 相手のポケモンで、ターンの後の場のポケモンではないが、そのターンに場にいたポケモン（ターンの始めの場のポケモン・交代先）の HP の欄
  const renderOppOthers = () => {
    const wrap = document.getElementById('opp-other-wrap')!;
    wrap.querySelectorAll<HTMLInputElement>('input.t-oppother').forEach(x => otherVals.set(Number(x.dataset.i), { v: x.value, touched: !!x.dataset.touched }));
    const after = Number(selOpp.value), opp = radio('t-opp');
    const ids: number[] = [];
    if (startOpp !== after) ids.push(startOpp);
    if (opp.startsWith('switch')) { const to = Number(opp.split(' ')[1]); if (to !== after && !ids.includes(to)) ids.push(to); }
    wrap.innerHTML = ids.map(i => { const o = otherVals.get(i); const v = o?.v ?? String(pred?.oppHps?.[i] ?? view.opp[i].hpPct); return `<span>${esc(jn('species', doc!.setup.oppSpecies[i]))}（場から下がった。倒れたら0）</span><span><input class="t-oppother big num" data-i="${i}" type="number" inputmode="numeric" min="0" max="100" value="${esc(v)}"${o?.touched ? ' data-touched="1"' : ''}> %</span>`; }).join('');
    wrap.querySelectorAll<HTMLInputElement>('input.t-oppother').forEach(x => x.addEventListener('input', () => { x.dataset.touched = '1'; }));
  };
  // こちらの HP の名札：（場）（控え）（倒れた）
  const labels = () => {
    const after = Number(selOur.value);
    document.querySelectorAll<HTMLElement>('.t-ourname').forEach(el => { const i = Number(el.dataset.i); el.textContent = jn('species', us.mons[i].set.species) + (hpOf(i) <= 0 ? '（倒れた）' : i === after ? '（場）' : '（控え）'); });
  };
  // 交代技（ボルトチェンジ・とんぼがえり等）を選んだら、交代先のボタンを出す（控えが残っているときだけ）
  const pivotRow = document.getElementById('row-pivot') as HTMLElement | null;
  const isPivot = (our: string) => our.startsWith('move ') && !!dex.moves[toID(us.mons[us.active].set.moves[Number(our.split(' ')[1])] ?? '')]?.selfSwitch;
  const update = () => {
    const our = radio('t-our'), opp = radio('t-opp');
    if (pivotRow) pivotRow.hidden = !(isPivot(our) && pivotRow.querySelector('input'));
    (document.getElementById('row-first') as HTMLElement).hidden = !(our.startsWith('move') && (opp.startsWith('move') || opp === 'other'));
    (document.getElementById('row-othermove') as HTMLElement).hidden = opp !== 'other';
    renderOppOthers(); labels();
  };
  // 行動を選んだら、ターンの後の場のポケモンを交代先にそろえる（手で選び直していなければ）
  const alignActives = () => {
    const our = radio('t-our'), opp = radio('t-opp');
    // 交代先のボタンで入れた場のポケモンは、交代技でない行動に選び直したら取り消す
    if (selOur.dataset.pivot && !isPivot(our)) { delete selOur.dataset.pivot; delete selOur.dataset.touched; document.querySelectorAll<HTMLInputElement>('input[name="t-pivot"]').forEach(x => { x.checked = false; }); }
    if (!selOur.dataset.touched) selOur.value = String(our.startsWith('switch') ? Number(our.split(' ')[1]) : us.active);
    if (!selOpp.dataset.touched) {
      const to = opp.startsWith('switch') ? Number(opp.split(' ')[1]) : startOpp;
      selOpp.value = String(to);
      if (!oppHp.dataset.touched) oppHp.value = String(view.opp[to].hpPct);
    }
  };
  const touch = (el: HTMLElement) => { el.dataset.touched = '1'; };
  document.querySelectorAll<HTMLInputElement>('.t-ourhp').forEach(x => x.addEventListener('input', () => { touch(x); update(); }));
  oppHp.addEventListener('input', () => touch(oppHp));
  // 場のポケモン・先に動いた側を直したら、その条件で予想し直す（交代技・ドラゴンテール等の交代先や、先手・後手で、どのポケモンがダメージを受けるかが変わる）
  selOur.addEventListener('change', () => { touch(selOur); delete selOur.dataset.pivot; syncPivot(); update(); void predictNow(); });
  // 交代先のボタンを押したら、こちらの場のポケモンの欄に入れて予想し直す。欄を直したら、ボタンもそろえる
  const syncPivot = () => document.querySelectorAll<HTMLInputElement>('input[name="t-pivot"]').forEach(x => { x.checked = !!selOur.dataset.touched && x.value === selOur.value; });
  document.querySelectorAll<HTMLInputElement>('input[name="t-pivot"]').forEach(x => x.addEventListener('change', () => { selOur.value = x.value; touch(selOur); selOur.dataset.pivot = '1'; update(); void predictNow(); }));
  selOpp.addEventListener('change', () => { touch(selOpp); const i = Number(selOpp.value); if (!oppHp.dataset.touched) oppHp.value = String(pred?.oppHps?.[i] ?? view.opp[i].hpPct); update(); void predictNow(); });
  for (const id of ['t-ourstatus', 't-oppstatus']) document.getElementById(id)!.addEventListener('change', e => touch(e.target as HTMLElement));
  document.querySelectorAll<HTMLInputElement>('input[name="t-first"]').forEach(x => x.addEventListener('change', () => { document.querySelectorAll<HTMLInputElement>('input[name="t-first"]').forEach(touch); void predictNow(); }));

  let predGen = 0;
  const actionsNow = (): { ours: TurnInput['ours']; opp: TurnInput['opp'] } | null => {
    const our = radio('t-our'), opp = radio('t-opp');
    if (!our || !opp) return null;
    const [ok, ov] = our.split(' ');
    const ours: TurnInput['ours'] = ok === 'none' ? { kind: 'none' } : ok === 'switch' ? { kind: 'switch', to: Number(ov) } : { kind: 'move', slot: Number(ov), mega: !!(document.getElementById('t-ourmega') as HTMLInputElement | null)?.checked };
    let oppAct: TurnInput['opp'];
    if (opp === 'none') oppAct = { kind: 'none' };
    else if (opp.startsWith('switch')) oppAct = { kind: 'switch', to: Number(opp.split(' ')[1]) };
    else {
      const mv = opp === 'other' ? resolve('moves', (document.getElementById('t-oppmove') as HTMLInputElement).value) : opp.slice(5);
      if (!mv) return null;
      oppAct = { kind: 'move', move: mv, mega: !!(document.getElementById('t-oppmega') as HTMLInputElement | null)?.checked };
    }
    return { ours, opp: oppAct };
  };
  const predictNow = async () => {
    alignActives(); update();
    const acts = actionsNow();
    if (!acts) return;
    const gen = ++predGen;
    (document.getElementById('t-result') as HTMLElement).hidden = false;
    const msg = document.getElementById('t-predmsg')!;
    msg.textContent = '（予想しています…）';
    let p: any = null;
    // 手で決めた条件：ターンの後の場のポケモン（交代先）と、先に動いた側
    const firstEl = document.querySelector<HTMLInputElement>('input[name="t-first"]:checked');
    const how = {
      ourTo: selOur.dataset.touched ? Number(selOur.value) : undefined,
      oppTo: selOpp.dataset.touched ? Number(selOpp.value) : undefined,
      first: firstEl?.dataset.touched && !(document.getElementById('row-first') as HTMLElement).hidden ? firstEl.value as 'us' | 'them' : undefined,
    };
    try { p = (await ask({ type: 'predict', input: acts, how })).pred; } catch { p = null; }
    if (gen !== predGen || !document.getElementById('t-result')) return;
    if (!p) { msg.textContent = '（予想できませんでした。画面の数字を入れてください）'; return; }
    pred = p;
    const setIf = (el: HTMLInputElement | HTMLSelectElement | null, v: string | number) => { if (el && !el.dataset.touched) el.value = String(v); };
    p.ourHps.forEach((h: number, i: number) => setIf(document.querySelector(`.t-ourhp[data-i="${i}"]`), h));
    // こちら：出ていたポケモン（交代先）が倒れる予想なら、そのポケモンのまま（死に出しの画面で交代先を選ぶ）
    const ourExp = acts.ours.kind === 'switch' ? acts.ours.to : us.active;
    setIf(selOur, p.ourHps[ourExp] <= 0 ? ourExp : p.ourActive);
    // 相手：出ていたポケモンが倒れて、こちらも倒れる・3匹目なら、そのポケモンのまま。そうでなければ予想した場のポケモン
    const oppExp = acts.opp.kind === 'switch' ? acts.opp.to : startOpp;
    const oppDown = (p.oppHps?.[oppExp] ?? p.oppHpPct) <= 0;
    const stay = oppDown && (p.ourHps[ourExp] <= 0 || view.opp.filter((o: any) => o.fainted).length + 1 >= 3);
    setIf(selOpp, stay ? oppExp : p.oppActive);
    setIf(oppHp, p.oppHps?.[Number(selOpp.value)] ?? p.oppHpPct);
    otherVals.clear();
    setIf(document.getElementById('t-ourstatus') as HTMLSelectElement, p.ourStatus || '');
    setIf(document.getElementById('t-oppstatus') as HTMLSelectElement, p.oppStatus || '');
    if (p.first) { const r = document.querySelector(`input[name="t-first"][value="${p.first}"]`) as HTMLInputElement | null; if (r && !r.dataset.touched) r.checked = true; }
    update();
    msg.textContent = `（予想を入れました。画面と違う所だけ直す。相手のHPの予想の幅 ${p.oppHpRange[0]}〜${p.oppHpRange[1]}%）`;
  };
  document.querySelectorAll<HTMLInputElement>('input[name="t-our"], input[name="t-opp"], #t-ourmega, #t-oppmega').forEach(x => x.addEventListener('change', predictNow));
  (document.getElementById('t-oppmove') as HTMLInputElement).addEventListener('change', predictNow);
  document.getElementById('t-record')!.onclick = recordTurn;
  update();
}

/** 死に出しの動き：出したポケモンを押すと、出てきた後の HP を予想して入れる。「出して計算」で記録する。 */
function bindReplace(radio: (n: string) => string) {
  const us = ourSide();
  const pend: number[] = view.pending ?? [];
  let gen = 0;
  const chosen = () => ({ ourTo: pend.includes(0) && radio('r-our') !== '' ? Number(radio('r-our')) : undefined, oppTo: pend.includes(1) && radio('r-opp') !== '' ? Number(radio('r-opp')) : undefined });
  const ready = () => { const c = chosen(); return (!pend.includes(0) || c.ourTo !== undefined) && (!pend.includes(1) || c.oppTo !== undefined); };
  document.querySelectorAll<HTMLInputElement>('.r-ourhp, #r-opphp').forEach(x => x.addEventListener('input', () => { x.dataset.touched = '1'; }));
  const preview = async () => {
    if (!ready()) return;
    const g = ++gen;
    const c = chosen();
    (document.getElementById('r-result') as HTMLElement).hidden = false;
    const name = document.getElementById('r-oppname'); if (name && c.oppTo !== undefined) name.textContent = `相手 ${jn('species', doc!.setup.oppSpecies[c.oppTo])}`;
    const msg = document.getElementById('r-predmsg')!; msg.textContent = '（予想しています…）';
    let p: any = null;
    try { p = (await ask({ type: 'replacePreview', input: c })).pred; } catch { p = null; }
    if (g !== gen || !document.getElementById('r-result')) return;
    if (!p) { msg.textContent = '（予想できませんでした。画面の数字を入れてください）'; return; }
    document.querySelectorAll<HTMLInputElement>('.r-ourhp').forEach(x => { if (!x.dataset.touched) x.value = String(p.ourHps[Number(x.dataset.i)]); });
    const oh = document.getElementById('r-opphp') as HTMLInputElement | null; if (oh && !oh.dataset.touched) oh.value = String(p.oppHpPct);
    msg.textContent = '（ステルスロック等を含めた予想を入れました。画面と違う所だけ直す）';
  };
  document.querySelectorAll<HTMLInputElement>('input[name="r-our"], input[name="r-opp"]').forEach(x => x.addEventListener('change', preview));
  document.getElementById('r-record')!.onclick = async () => {
    const msgEl = document.getElementById('r-msg')!;
    if (!ready()) { msgEl.textContent = pend.includes(0) && chosen().ourTo === undefined ? 'こちらが出すポケモンを選んでください。' : '相手が出したポケモンを選んでください。'; return; }
    const c = chosen();
    const ourHps = us.mons.map((m: any, i: number) => { const el = document.querySelector(`.r-ourhp[data-i="${i}"]`) as HTMLInputElement | null; return el ? Number(el.value) : m.hp; });
    const abText = (document.getElementById('r-oppab') as HTMLInputElement | null)?.value ?? '', itemText = (document.getElementById('r-oppitem') as HTMLInputElement | null)?.value ?? '';
    const input: ReplaceInput = { ...c, ourHps, oppHpPct: c.oppTo !== undefined ? Number((document.getElementById('r-opphp') as HTMLInputElement).value) : undefined, oppAbility: abText ? resolve('abilities', abText) || undefined : undefined, oppItem: itemText ? resolve('items', itemText) || undefined : undefined };
    doc!.turns.push({ replace: input } as any);
    store(KEY_BATTLE, doc);
    const t0 = performance.now();
    result = null; searching = true;
    (document.getElementById('result') as HTMLElement).innerHTML = '<p>記録して計算中…</p>';
    try { view = (await ask({ type: 'replace', input })).view; } finally { searching = false; }
    renderBattle();
    runSearch(t0);
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
  // 画面の並び（場のポケモンが先頭）ではなく、欄のポケモンの番号（data-i）の順に読む
  const ourHps: number[] = [];
  document.querySelectorAll<HTMLInputElement>('.t-ourhp').forEach(x => { ourHps[Number(x.dataset.i)] = Number(x.value); });
  // ターンの後の場のポケモン（両方）と HP。こちらの場のポケモンの HP が0なら、交代先はまだ（死に出しの画面で選ぶ）
  const ourActive = Number((document.getElementById('t-ouractive') as HTMLSelectElement).value);
  const oppActive = Number((document.getElementById('t-oppactive') as HTMLSelectElement).value);
  const oppHpPct = Number((document.getElementById('t-opphp') as HTMLInputElement).value);
  const oppHps: Record<number, number> = {};
  document.querySelectorAll<HTMLInputElement>('input.t-oppother').forEach(x => { oppHps[Number(x.dataset.i)] = Number(x.value); });
  const oppDownAfter = view.opp.filter((o: any, i: number) => o.fainted || (oppHps[i] !== undefined && oppHps[i] <= 0) || (i === oppActive && oppHpPct <= 0)).length;
  if (oppHpPct <= 0 && ourHps[ourActive] > 0 && oppDownAfter < 3) { msgEl.textContent = '相手の場のポケモンが倒れたときは、相手が出したポケモンを「相手の場のポケモン」で選び、倒れたポケモンの HP は0にしてください。'; return; }
  const ourStatus = (document.getElementById('t-ourstatus') as HTMLSelectElement).value as StatusID;
  const oppStatus = (document.getElementById('t-oppstatus') as HTMLSelectElement).value as StatusID;
  const critOpp = (document.getElementById('t-critopp') as HTMLInputElement).checked, critUs = (document.getElementById('t-critus') as HTMLInputElement).checked;
  const input: TurnInput = {
    ours, opp: oppAct, first: ours.kind === 'move' && oppAct.kind === 'move' ? first : undefined,
    // 急所は、印をつけたときだけ「急所だった」。つけていなければ分からない（undefined）として計算する
    critOnOpp: critOpp ? true : undefined, critOnUs: critUs ? true : undefined,
    oppItem: oppItem || undefined, oppAbility: oppAbility || undefined,
    ourMega: !!(document.getElementById('t-ourmega') as HTMLInputElement | null)?.checked, oppMega: !!(document.getElementById('t-oppmega') as HTMLInputElement | null)?.checked,
    after: { ourActive, ourHp: ourHps[ourActive], ourStatus, oppActive, oppHpPct, oppStatus, ourHps, oppHps: Object.keys(oppHps).length ? oppHps : undefined },
  };
  doc!.turns.push({ input });
  store(KEY_BATTLE, doc);
  // 前のターンのおすすめを、押した時点で消す（記録の途中で古いおすすめを見せない）
  // 計算時間は「記録して計算」を押した時点から数える（ターンの再現にかかった時間を、探索の時間から引く）
  const t0 = performance.now();
  result = null; searching = true;
  (document.getElementById('result') as HTMLElement).innerHTML = '<p>記録して計算中…</p>';
  try { view = (await ask({ type: 'record', input })).view; } finally { searching = false; }
  renderBattle();
  runSearch(t0);
}

/** t0 から数えて、計算時間（既定10秒）の中に収める。探索の後のまとめと表示の分として、少し残して打ち切る。 */
async function runSearch(t0 = performance.now()) {
  if (!view) return;
  // 決着していれば探索しない
  if (!view.pos.sides[0].mons.some((m: any) => m.hp > 0) || view.opp.filter((o: any) => o.fainted).length >= 3) { result = null; searching = false; renderBattle(); return; }
  searching = true; renderBattle();
  try {
    const budget = load<number>(KEY_TIME, 10000);
    const { positions } = await ask({ type: 'dets', k: searchSettings.dets, seed: Date.now() & 0xffffffff });
    const prepMs = performance.now() - t0;
    // 再現が長すぎて残りがないときも、手を出すために最低1秒は探索する
    const r = await pool.run(positions as Position[], Math.max(1000, budget - prepMs - 300), { c: searchSettings.c, depth: searchSettings.depth });
    result = { ...r, prepMs, totalMs: performance.now() - t0, budget };
  } catch (e: any) { message = `計算のエラー：${e.message}`; }
  searching = false; renderBattle();
}

async function refresh() {
  if (!doc) { renderSetup(); return; }
  app.innerHTML = '<p>記録から盤面を作っています…</p>';
  view = (await ask({ type: 'replay', battle: doc })).view;
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
  const ls = await fetchJson(`${base}data/learn/settings.json`);
  if (ls?.settings) searchSettings = { ...DEFAULT_SETTINGS, ...ls.settings };
  await ask({ type: 'load', priorsUrl: `${base}data/priors/sets.json`, teamsUrl: `${base}data/seed/teams_m7.json`, selectionsUrl: `${base}data/seed/selections_m7.json`, learnedUrl: `${base}data/priors/learned.json` });
  await refresh();
}
(window as any).__battle = { get doc() { return doc; }, get view() { return view; }, get result() { return result; }, get searching() { return searching; } };
main().catch(e => { app.innerHTML = `<p>エラー：${esc(String(e?.message ?? e))}</p>`; });
