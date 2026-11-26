# 初期データの点検結果

Showdown のコミット c7fa6f16503de510c319239b5b2d29d4f7abd8c4、形式 gen9championsbssregmc の検査（TeamValidator）にかけた結果。

- 構築の数：206
- 選出データの数：184（記事に選出の情報があるもの：167）
- 選出データの順位で、構築にないもの：なし
- 記事URLが同じ構築：4 組
  - 順位 25, 53（6体が同じ）：https://sibakentomodachi.livedoor.blog/archives/1084584339.html
  - 順位 101, 228（6体が同じ）：https://note.com/ashinagatoon/n/na84843a6c6eb?sub_rt=share_pw
  - 順位 691, 899（6体が同じ）：https://arisayapoke0195.hatenablog.com/entry/2026/11/04/231515
  - 順位 719, 855（6体が同じ）：https://note.com/jolly_shark9509/n/n2c0e69336b5f?sub_rt=share_pb
- 記事URLがない構築：3, 13, 47, 87, 97, 104, 124, 164, 175, 193, 200, 206, 238, 241, 256, 257, 261, 265, 277, 278, 289, 297
- 能力ポイントの合計が66でないもの：5 体
  - 合計65：68位 カメックス、239位 ヒートロトム、285位 ガルーラ、965位 ボーマンダ
  - 合計32：823位 メタモン
- 技が4つ未満：151位 メタモン（1つ）、234位 メタモン（1つ）、544位 メタモン（1つ）、817位 メタモン（1つ）、823位 メタモン（1つ）

## Showdown の検査で問題が出た構築

- 59位：Indeedee can't learn Baton Pass.
- 63位：Meowscarada needs to have an ability. / Meowscarada's ability No Ability does not exist in Gen 9.
- 230位：Pyroar needs to have an ability. / Pyroar's ability No Ability does not exist in Gen 9.
- 234位：Salamence needs to have an ability. / Salamence's ability No Ability does not exist in Gen 9. / Venusaur needs to have an ability. / Venusaur's ability No Ability does not exist in Gen 9.
- 667位：Metagross needs to have an ability. / Metagross's ability No Ability does not exist in Gen 9. / Charizard needs to have an ability. / Charizard's ability No Ability does not exist in Gen 9. / Primarina needs to have an ability. / Primarina's ability No Ability does not exist in Gen 9. / Hippowdon needs to have an ability. / Hippowdon's ability No Ability does not exist in Gen 9. / Garchomp needs to have an ability. / Garchomp's ability No Ability does not exist in Gen 9.
- 750位：Delphox needs to have an ability. / Delphox's ability No Ability does not exist in Gen 9. / Metagross needs to have an ability. / Metagross's ability No Ability does not exist in Gen 9.
- 911位：Lucario needs to have an ability. / Lucario's ability No Ability does not exist in Gen 9. / Blaziken needs to have an ability. / Blaziken's ability No Ability does not exist in Gen 9.

問題なし：199 構築、問題あり：7 構築。

特性が空の個体は、エンジンでは Showdown の種族の最初の特性として扱う予定（未確定）。
