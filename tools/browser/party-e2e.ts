// パーティの入力画面の確かめ（Playwright、Chromium）。先に npm run build が必要。
// 利用者のチーム2（test/fixtures/party-team2-screen.json）を日本語で入力し、
//  1. 実数値が、ゲーム画面の数字と一致する
//  2. 保存すると、偽の GitHub に正しい中身が PUT される（合い鍵つき）
//  3. 再読み込みで入力が戻る
//  4. 入力の確認に問題が出ない
// を確かめる。スクリーンショットを .build/party.png に保存する。
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const screen = JSON.parse(readFileSync('test/fixtures/party-team2-screen.json', 'utf8'));
const ja = JSON.parse(readFileSync('data/names/ja.json', 'utf8'));
const toID = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const hira = (s: string) => s.replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
const STATS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];

const server = spawn('npx', ['vite', 'preview', '--port', '4176', '--strictPort'], { stdio: 'ignore', detached: true });
const url = 'http://localhost:4176/kaufhfhsyhwjaijdheysy/party.html';
for (let i = 0; i < 50; i++) { try { await fetch(url); break; } catch { await new Promise(r => setTimeout(r, 300)); } }
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
const errors: string[] = [];
page.on('pageerror', (e: any) => errors.push(String(e)));
// 偽の GitHub：GET は「まだない」、PUT は受け付けて中身を記録
const puts: any[] = [];
await page.route('https://api.github.com/**', async (route: any) => {
  const req = route.request();
  if (req.method() === 'GET') return route.fulfill({ status: 404, body: '{}' });
  puts.push({ url: req.url(), auth: req.headers()['authorization'], body: JSON.parse(req.postData()) });
  return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ commit: { sha: 'fake' } }) });
});

let ok = true;
const check = (cond: boolean, what: string) => { console.log(`${cond ? '合格' : '不合格'}：${what}`); if (!cond) ok = false; };

await page.goto(url);
await page.waitForSelector('.mon', { timeout: 60000 });
await page.fill('#party-name', 'チーム2');
// 「よく使う」の印をつける（裏の計算の対象になる）
await page.check('#party-precompute');
for (const [i, m] of screen.entries()) {
  const card = () => page.locator(`.mon[data-slot="${i}"]`);
  const sp = ja.species[toID(m.species)];
  await card().locator('.f-species').fill(i === 0 ? hira(sp) : sp);   // 1匹目はひらがなで入れる
  await card().locator('.f-species').dispatchEvent('change');
  await card().locator('.f-gender').selectOption(m.gender || '');
  await card().locator('.f-item').fill(ja.items[toID(m.item)]);
  await card().locator('.f-item').dispatchEvent('change');
  await card().locator('.f-ability').selectOption(m.ability);
  await card().locator('.f-nature').selectOption(m.nature);
  for (const s of STATS) await card().locator(`.f-sp[data-stat="${s}"]`).fill(String(m.evs[s]));
  for (const [k, mv] of m.moves.entries()) {
    await card().locator(`.f-move[data-k="${k}"]`).fill(ja.moves[toID(mv)]);
    await card().locator(`.f-move[data-k="${k}"]`).dispatchEvent('change');
  }
}
const readStats = async () => {
  const out: Record<string, number>[] = [];
  for (let i = 0; i < 6; i++) {
    const r: Record<string, number> = {};
    for (const s of STATS) r[s] = Number(await page.locator(`.mon[data-slot="${i}"] .stat[data-stat="${s}"]`).textContent());
    out.push(r);
  }
  return out;
};
const stats = await readStats();
check(screen.every((m: any, i: number) => STATS.every(s => stats[i][s] === m.shown[s])), '実数値が、ゲーム画面の数字と6匹×6項目すべて一致する');
check((await page.locator('#problems').textContent())!.includes('問題はありません'), '入力の確認に問題が出ない');

// 合い鍵を入れて保存
await page.fill('#token', 'github_pat_TESTONLY');
await page.click('#token-save');
await page.click('#save');
await page.waitForFunction(() => /リポジトリに保存しました|失敗/.test(document.getElementById('msg')?.textContent ?? ''), null, { timeout: 30000 });
console.log('保存後の表示：', await page.textContent('#msg'));
check(puts.length === 1, 'GitHub に PUT が1回送られた');
if (puts.length) {
  const p = puts[0];
  const content = JSON.parse(Buffer.from(p.body.content, 'base64').toString('utf8'));
  check(/\/repos\/Ryota-afk\/kaufhfhsyhwjaijdheysy\/contents\/data\/parties\/p\d+\.json$/.test(p.url), `書き込み先が data/parties/ の下（${p.url.split('/contents/')[1]}）`);
  check(p.auth === 'Bearer github_pat_TESTONLY', '合い鍵が Authorization に入っている');
  check(p.body.branch === 'main' && !p.body.sha, '新しいファイルとして main に書く');
  const want = screen.map((m: any) => ({ species: m.species, item: m.item, ability: m.ability, nature: m.nature, evs: m.evs, moves: m.moves, gender: m.gender }));
  const got = content.mons.map((m: any) => ({ species: m.species, item: m.item, ability: m.ability, nature: m.nature, evs: m.evs, moves: m.moves, gender: m.gender }));
  check(JSON.stringify(got) === JSON.stringify(want) && content.name === 'チーム2', '書き込む中身が、入力した6匹と名前に一致する');
  check(!JSON.stringify(p.body).includes('github_pat_'), '書き込む中身に合い鍵が入っていない');
  check(content.precompute === true, '「よく使う」の印が書き込む中身に入っている');
}
await page.screenshot({ path: '.build/party.png', fullPage: true });

// 再読み込み
await page.reload();
await page.waitForSelector('.mon', { timeout: 60000 });
const stats2 = await readStats();
check(JSON.stringify(stats2) === JSON.stringify(stats), '再読み込み後も実数値が同じ');
const restored = [];
for (let i = 0; i < 6; i++) {
  const c = page.locator(`.mon[data-slot="${i}"]`);
  restored.push({
    species: await c.locator('.f-species').inputValue(), item: await c.locator('.f-item').inputValue(),
    ability: await c.locator('.f-ability').inputValue(), nature: await c.locator('.f-nature').inputValue(),
    moves: await Promise.all([0, 1, 2, 3].map(k => c.locator(`.f-move[data-k="${k}"]`).inputValue())),
    sp: await Promise.all(STATS.map(s => c.locator(`.f-sp[data-stat="${s}"]`).inputValue())),
  });
}
const expectRestored = screen.map((m: any) => ({
  species: ja.species[toID(m.species)], item: ja.items[toID(m.item)], ability: m.ability, nature: m.nature,
  moves: m.moves.map((x: string) => ja.moves[toID(x)]), sp: STATS.map(s => String(m.evs[s])),
}));
check(JSON.stringify(restored) === JSON.stringify(expectRestored), '再読み込み後、6匹の名前・持ち物・特性・性格・能力ポイント・技が戻る');
check(await page.inputValue('#party-name') === 'チーム2', '再読み込み後、パーティの名前が戻る');
check(await page.isChecked('#party-precompute'), '再読み込み後、「よく使う」の印が戻る');
if (errors.length) console.log('ページのエラー：', errors);
check(!errors.length, 'ページのエラーがない');
await browser.close();
process.kill(-server.pid!);
console.log(ok ? 'すべて合格' : '不合格あり');
process.exitCode = ok ? 0 : 1;
