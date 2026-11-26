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
npm run compare          # エンジンと Showdown の照合（docs/engine-compare.md）
npm run rules            # 指示文 4-1. の項目の確かめ（docs/rules-check.md）
npm run bench            # 速さの測定
```

対戦エンジンの作りと速さは docs/engine.md にある。

対戦の仕組みは Pokémon Showdown（MITライセンス、https://github.com/smogon/pokemon-showdown）をそのまま使う。使用許諾は THIRD_PARTY_NOTICES.md。
