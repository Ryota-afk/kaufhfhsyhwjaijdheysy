// fidelity.ts の結果をまとめる：回数の違う AI で、同じマスの勝率がどれだけ違うか
import { readFileSync, existsSync } from 'node:fs';
const [A, B] = (process.argv[2] ?? '25,100').split(',').map(Number);
const read = (K: number) => { const cells = new Map<number, any>(); let sec = 0, games = 0; for (let s = 0; s < 8; s++) { const f = `.build/fidelity-${K}-${s}.json`; if (!existsSync(f)) continue; const d = JSON.parse(readFileSync(f, 'utf8')); sec += d.seconds; for (const c of d.cells) { cells.set(c.k, c); games += c.n; } } return { cells, sec, games }; };
const a = read(A), b = read(B);
const ks = [...a.cells.keys()].filter(k => b.cells.has(k)).sort((x, y) => x - y);
let sumD = 0, sumZ2 = 0; const xs: number[] = [], ys: number[] = [];
for (const k of ks) {
  const pa = a.cells.get(k).w / a.cells.get(k).n, pb = b.cells.get(k).w / b.cells.get(k).n;
  const se = Math.sqrt(Math.max(pa * (1 - pa), 0.01) / a.cells.get(k).n + Math.max(pb * (1 - pb), 0.01) / b.cells.get(k).n);
  xs.push(pa); ys.push(pb); sumD += Math.abs(pa - pb); sumZ2 += ((pa - pb) / se) ** 2;
  console.log(`マス ${a.cells.get(k).r},${a.cells.get(k).c}：回数${A} ${pa.toFixed(2)} ／ 回数${B} ${pb.toFixed(2)}`);
}
const mean = (v: number[]) => v.reduce((x, y) => x + y, 0) / v.length;
const mx = mean(xs), my = mean(ys);
const cov = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0), vx = xs.reduce((s, x) => s + (x - mx) ** 2, 0), vy = ys.reduce((s, y) => s + (y - my) ** 2, 0);
console.log(`マス ${ks.length}：差の絶対値の平均 ${(sumD / ks.length).toFixed(3)}、相関 ${(cov / Math.sqrt(vx * vy)).toFixed(3)}、差の大きさ（誤差で割った2乗の平均。偶然だけなら約1） ${(sumZ2 / ks.length).toFixed(2)}`);
console.log(`1試合の時間（1スレッド）：回数${A} ${(a.sec / a.games).toFixed(2)}秒、回数${B} ${(b.sec / b.games).toFixed(2)}秒`);
