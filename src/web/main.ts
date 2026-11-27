// 段階0：サイトが開けることと、data/ の初期データが読めることを示すだけの画面。
interface SeedTeam { rank: number; season: string; mons: { jp: string }[] }

const app = document.getElementById('app')!;

async function main() {
  const base = import.meta.env.BASE_URL;
  const res = await fetch(`${base}data/seed/teams_m7.json`);
  if (!res.ok) throw new Error(`初期データを読めません（${res.status}）`);
  const teams: SeedTeam[] = await res.json();
  const rows = teams.slice(0, 5).map(t =>
    `<tr><td>${t.rank}位</td><td>${t.mons.map(m => m.jp).join('・')}</td></tr>`).join('');
  app.innerHTML = `
    <p><a href="battle.html">対戦中の判断</a> ／ <a href="party.html">パーティの入力</a> ／ <a href="bench.html">速さの測定</a></p>
    <p>初期データ：シーズン${teams[0]?.season ?? '?'}の上位構築 <strong id="team-count">${teams.length}</strong> 件を読み込みました。</p>
    <table><thead><tr><th>順位</th><th>6体</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="muted">上位5件だけを表示しています。</p>`;
}

main().catch(e => { app.innerHTML = `<p>エラー：${(e as Error).message}</p>`; });
