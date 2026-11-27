// 測定ページ：Web Worker の中で Showdown（そのまま／速さの層あり）を回し、1秒あたりのターン数と複製の時間を表示する。
// Playwright での確かめ用に、window.__bench と window.__runJobs も用意する。
const out = document.getElementById('out')!;
const base = import.meta.env.BASE_URL;

function newWorker(layer: boolean): Promise<Worker> {
  const w = new Worker(new URL('../engine/browser/worker.ts', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    w.onmessage = ev => { if (ev.data.type === 'ready') resolve(w); else if (ev.data.type === 'error') reject(new Error(ev.data.message)); };
    w.onerror = e => reject(new Error(e.message));
    w.postMessage({ type: 'init', layer });
  });
}
function call(w: Worker, msg: any): Promise<any> {
  return new Promise((resolve, reject) => {
    w.onmessage = ev => { if (ev.data.type === 'error') reject(new Error(ev.data.message)); else resolve(ev.data); };
    w.postMessage(msg);
  });
}
async function loadTeams() {
  const teams = await (await fetch(`${base}data/seed/teams_m7.json`)).json();
  return teams.filter((t: any) => t.mons.every((m: any) => m.ability));
}

async function bench(seconds = 20) {
  const teams = await loadTeams();
  const results: any[] = [];
  for (const layer of [false, true]) {
    const w = await newWorker(layer);
    await call(w, { type: 'bench', teams, seconds: 3 }); // 慣らし
    const r = await call(w, { type: 'bench', teams, seconds });
    w.terminate();
    results.push(r);
  }
  // 探索1回相当（複製＋2ターン）を、速さの層ありの Worker を1つ・2つ・論理コア数だけ並べて回す
  const iter: { workers: number; itersPerSec: number }[] = [];
  const counts = [...new Set([1, 2, navigator.hardwareConcurrency || 2])];
  for (const n of counts) {
    const ws = await Promise.all(Array.from({ length: n }, () => newWorker(true)));
    await Promise.all(ws.map(w => call(w, { type: 'iter', teams, seconds: 2 })));
    const rs = await Promise.all(ws.map(w => call(w, { type: 'iter', teams, seconds: Math.max(5, seconds / 2) })));
    ws.forEach(w => w.terminate());
    iter.push({ workers: n, itersPerSec: rs.reduce((a, r) => a + r.itersPerSec, 0) });
  }
  return { results, iter, cores: navigator.hardwareConcurrency, ua: navigator.userAgent };
}
async function runJobs(jobs: any[], layer: boolean) {
  const w = await newWorker(layer);
  const r = await call(w, { type: 'jobs', jobs });
  w.terminate();
  return r.res;
}
(window as any).__bench = bench;
(window as any).__runJobs = runJobs;

document.getElementById('start')!.addEventListener('click', async () => {
  const btn = document.getElementById('start') as HTMLButtonElement;
  btn.disabled = true;
  out.innerHTML = '<p>測定中…（約2分）</p>';
  try {
    const { results, iter, cores, ua } = await bench(20);
    const row = (r: any) => `<tr><td>${r.layer ? '速さの層あり' : 'Showdown そのまま'}</td><td>${Math.round(r.turnsPerSec)}</td><td>${Math.round(r.cloneUs)}</td><td>${r.games}</td></tr>`;
    out.innerHTML = `<table><thead><tr><th>種類</th><th>1秒あたりのターン数</th><th>複製1回（µs）</th><th>試合数</th></tr></thead><tbody>${results.map(row).join('')}</tbody></table>
      <table><thead><tr><th>並べた Worker の数</th><th>探索1回相当（複製＋2ターン）の1秒あたりの回数（合計）</th></tr></thead><tbody>${iter.map((r: any) => `<tr><td>${r.workers}</td><td>${Math.round(r.itersPerSec)}</td></tr>`).join('')}</tbody></table>
      <p class="muted">論理コア数：${cores}<br>ブラウザ：${ua}</p>
      <p>この表の数字を、そのまま伝えてください。</p>`;
  } catch (e: any) {
    out.innerHTML = `<p>エラー：${e.message}</p>`;
  } finally { btn.disabled = false; }
});
