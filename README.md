# チャンピオンズ選出補助

ポケモンチャンピオンズのシングル（6体から3体を選ぶランクバトル）で、選出と対戦中の判断を手伝うサイト。

- サイト：https://ryota-afk.github.io/kaufhfhsyhwjaijdheysy/
- 指示文：CLAUDE.md
- 対応表と進み具合：docs/plan.md

## 開発

```
npm ci
npm test
npm run build
npm run showdown:setup   # 照合の基準にする Pokémon Showdown を vendor/ に取得・組み立て
npm run seed:check       # 初期データを Showdown の検査にかける
```

対戦の仕組みの正しさの基準は Pokémon Showdown（MITライセンス、https://github.com/smogon/pokemon-showdown）。
