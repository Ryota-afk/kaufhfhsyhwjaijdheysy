// Showdown（vendor/showdown/dist）を、ブラウザ（Web Worker）で動く1つの ESM ファイルに組み立てる。
// 出力：.build/showdown-browser.mjs（export { PS }）
// Node だけの機能は次のとおり差し替える。
//   __dirname        → 仮の場所の文字列（/sd/sim など）
//   require(変数)     → 組み立て時に入れておいたデータのモジュールを、仮の場所で引く
//   fs.readdirSync   → mod の名前の一覧（組み立て時に読んだもの）
//   path             → 最小限の posix 版
//   node:crypto      → ブラウザの crypto
// 覚えられる技の表（Learnsets）は対戦の処理に使わないので空にする（チームの検査はブラウザではしない）。
import { build } from 'esbuild';
import { readdirSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const SD = resolve(ROOT, 'vendor/showdown/dist');
if (!existsSync(SD)) throw new Error('先に npm run showdown:setup を実行してください。');
const OUT = resolve(ROOT, '.build/showdown-browser.mjs');
const virt = (abs: string) => '/sd/' + relative(SD, abs).split('\\').join('/');

// 読み込むデータのモジュール（基本と champions）
const DATA_TYPES = ['abilities', 'rulesets', 'formats-data', 'items', 'moves', 'natures', 'pokedex', 'pokemongo', 'scripts', 'conditions', 'typechart'];
const mods = readdirSync(resolve(SD, 'data/mods'));
const entries: [string, string][] = []; // [仮の場所, 実際のファイル]
for (const t of DATA_TYPES) {
  const f = resolve(SD, `data/${t}.js`); if (existsSync(f)) entries.push([`/sd/data/${t}`, f]);
  const g = resolve(SD, `data/mods/champions/${t}.js`); if (existsSync(g)) entries.push([`/sd/data/mods/champions/${t}`, g]);
}
entries.push(['/sd/data/aliases', resolve(SD, 'data/aliases.js')]);
entries.push(['/sd/config/formats', resolve(SD, 'config/formats.js')]);

const entrySrc = [
  `import * as battle from ${JSON.stringify(resolve(SD, 'sim/battle.js'))};`,
  `import * as dex from ${JSON.stringify(resolve(SD, 'sim/dex.js'))};`,
  `import * as teams from ${JSON.stringify(resolve(SD, 'sim/teams.js'))};`,
  `import * as side from ${JSON.stringify(resolve(SD, 'sim/side.js'))};`,
  `import * as pokemon from ${JSON.stringify(resolve(SD, 'sim/pokemon.js'))};`,
  `import * as state from ${JSON.stringify(resolve(SD, 'sim/state.js'))};`,
  `import * as utils from ${JSON.stringify(resolve(SD, 'lib/utils.js'))};`,
  `import * as prng from ${JSON.stringify(resolve(SD, 'sim/prng.js'))};`,
  ...entries.map(([, f], i) => `import * as m${i} from ${JSON.stringify(f)};`),
  `const M = globalThis.__SD_MODULES;`,
  ...entries.map(([v], i) => `M[${JSON.stringify(v)}] = m${i};`),
  `M['/sd/data/learnsets'] = { Learnsets: {} };`,
  `M['/sd/data/mods/champions/learnsets'] = { Learnsets: {} };`,
  `export const PS = { Battle: battle.Battle, Dex: dex.Dex, Teams: teams.Teams, Side: side.Side, Pokemon: pokemon.Pokemon, State: state.State, Utils: utils.Utils, PRNG: prng.PRNG };`,
].join('\n');

// require(変数) の受け口。データのモジュールより先に用意する（banner）。
const banner = `
globalThis.__SD_MODULES = globalThis.__SD_MODULES || {};
globalThis.__SD_MODS = ${JSON.stringify(mods)};
globalThis.__sdDeepEqual = function deq(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (Array.isArray(a)) { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (!deq(a[i], b[i])) return false; return true; }
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) { if (!Object.prototype.hasOwnProperty.call(b, k) || !deq(a[k], b[k])) return false; }
  return true;
};
if (typeof globalThis.require === 'undefined') {
  globalThis.require = function (p) {
    let s = String(p).replace(/\\\\/g, '/').replace(/\\.js$/, '');
    const parts = [];
    for (const seg of s.split('/')) { if (seg === '..') parts.pop(); else if (seg && seg !== '.') parts.push(seg); }
    s = '/' + parts.join('/');
    const m = globalThis.__SD_MODULES[s];
    if (m) return m;
    if (s === '/node:crypto' || s === '/crypto') return globalThis.crypto;
    const e = new Error('Cannot find module ' + s); e.code = 'MODULE_NOT_FOUND'; throw e;
  };
}
`;

const shimPath = `export function resolve(...a){let p='';for(const x of a){if(!x)continue;p=x.startsWith('/')?x:(p+'/'+x);}const parts=[];for(const seg of p.split('/')){if(seg==='..')parts.pop();else if(seg&&seg!=='.')parts.push(seg);}return '/'+parts.join('/');}
export function join(...a){return resolve(...a);}
export function dirname(p){return p.split('/').slice(0,-1).join('/')||'/';}
export function basename(p,ext){let b=p.split('/').pop();if(ext&&b.endsWith(ext))b=b.slice(0,-ext.length);return b;}
export function extname(p){const b=p.split('/').pop();const i=b.lastIndexOf('.');return i>0?b.slice(i):'';}
export const sep='/';export default {resolve,join,dirname,basename,extname,sep};`;
const shimFs = `export function readdirSync(d){ if(String(d).endsWith('/data/mods')) return globalThis.__SD_MODS; return []; }
export function existsSync(){return false;} export function readFileSync(){throw Object.assign(new Error('fs'),{code:'ENOENT'});}
export default {readdirSync,existsSync,readFileSync};`;

await build({
  stdin: { contents: entrySrc, resolveDir: ROOT, sourcefile: 'showdown-entry.js', loader: 'js' },
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', outfile: OUT,
  banner: { js: banner }, minify: false, legalComments: 'inline', logLevel: 'warning',
  nodePaths: [resolve(SD, '../node_modules')],
  plugins: [{
    name: 'showdown-browser',
    setup(b) {
      b.onResolve({ filter: /^(node:)?path$/ }, () => ({ path: 'path', namespace: 'shim' }));
      b.onResolve({ filter: /^(node:)?fs$/ }, () => ({ path: 'fs', namespace: 'shim' }));
      b.onLoad({ filter: /.*/, namespace: 'shim' }, a => ({ contents: a.path === 'path' ? shimPath : shimFs, loader: 'js' }));
      b.onLoad({ filter: /vendor[\\/]showdown[\\/]dist[\\/].*\.js$/ }, a => {
        let src = readFileSync(a.path, 'utf8');
        src = src.replace(/\b__dirname\b/g, JSON.stringify(virt(dirname(a.path))));
        // require("node:crypto") は静的に見えるので、ブラウザの crypto に置き換える
        src = src.replace(/require\("node:crypto"\)/g, 'globalThis.crypto');
        // 中身が実行時に決まる読み込み（データのファイル、ランダム対戦のチーム作り）は、esbuild に取り込ませず実行時の受け口に回す
        src = src.replace(/\brequire\((`|filePath\)|path\.resolve\(|"\.\.\/data\/random-battles|"\.\.\/data\/mods\/gen9ssb)/g, 'globalThis.require($1');
        // node:util の isDeepStrictEqual（種族データの比較）は、同じ意味の関数に置き換える
        src = src.replace(/require\("node:util"\)/g, '{ isDeepStrictEqual: globalThis.__sdDeepEqual }');
        return { contents: src, loader: 'js' };
      });
    },
  }],
});
mkdirSync(dirname(OUT), { recursive: true });
const size = readFileSync(OUT).length;
console.log(`組み立てた：${relative(ROOT, OUT)}（${(size / 1024 / 1024).toFixed(1)} MB、データのモジュール ${entries.length} 個、mod ${mods.length} 個）`);
