# MyCryptoWars

**MCH のヒーロー・ランド・エネミーで遊ぶ、 ヘックスマップのターン制シミュレーション**（非公式ファンゲーム・MVP）。

「めっちゃ便利なスマホを持って、英雄たちが集う異世界に転生した」。 画面はスマホ 1 台。
MCH Map / Chat / Calendar / Drive / Photo の 5 つのアプリでヒーローに指示を出し、
9 つのランドの 1 つを率いて、 内政・探索・関所（砦）の攻略を 28 日（4 週）で競います。

- **プロジェクト目的とスコープ**: `docs/charters/PROJECT_CHARTER.md`
- **原案（企画構想）**: `docs/concept.md`
- **MVP の仕様**: `docs/specs/SPEC-109-mycryptowars-mvp.md`
- **モジュール間の契約**: `docs/specs/SPEC-110-engine-contract.md`
- **Claude Code 開発ガイド**: `CLAUDE.md`

このリポジトリは旧 MyCryptoTCG（カードバトル）を作り直したものです（SPEC-109）。

## 遊び方（ローカル）

ビルド不要の静的サイトです。 リポジトリのルートで静的サーバーを起動して開きます
（`index.html` を直接開くと `data/*.json` を読めません）。

```bash
python3 -m http.server 8080
# http://localhost:8080
```

## ゲームの流れ

1. ランドを 1 つ選ぶ（残り 8 ランドは CPU）
2. 【指示フェーズ】 Chat でヒーローに 移動 / 占領 / 開拓 / 戦闘 / 内政 / 休息 を積む。 Map で経路を引いても同じ
3. 【実行フェーズ】 Map の上で全ランドが 1 歩ずつ動く。 戦闘は 回避 → 防御 → ダメージ の順
4. 日曜（7・14・21・28 日目）の終わりに、 砦を持つランドに砦ポイント（Rare 1 / Epic 3 / Legendary 10）
5. **Legendary 砦を落とすとクリア**。 落とせなければ 28 日目の終わり（バッテリー切れ）に砦ポイントで順位
6. エネミーの砦を落とすと **SOUL**（3 体から 1 体を選ぶ）と **エクステンション**（スワイプで選ぶ）

## 技術スタック

- プレーン ES Modules + バニラ JS（TypeScript / バンドラ / フレームワーク なし、 `package.json` なし）
- HTML 単一エントリ（`index.html`）、 静的 host で `build:` 不要
- データは `data/*.json` から runtime fetch。 ヒーローのデータは `node tools/build-data.mjs --repo <mycryptoheroes の clone>` で生成
- 画像・音声は `js/constants.js` の `ASSET_BASE`（`bearko/mycryptoheroes` の raw URL）から解決。 リポジトリにバイナリは置かない
- エンジン（`js/engine/*`）は DOM に触れない純粋関数。 シード付き乱数で再現できる
- localStorage prefix: `mcw`

## 開発

```bash
for f in js/*.js js/engine/*.js js/ui/*.js; do node --check "$f"; done   # 構文
node --test tests/*.test.mjs                                               # テスト
node tools/sim.mjs 7 10                                                    # 28 日の無人シミュレーション（seed 7 から 10 回）
node tools/build-data.mjs --repo ../mycryptoheroes                         # data/heroes.json と data/enemies.json を作り直す
```

CI（`.github/workflows/ci.yml`）は push / PR ごとに 構文 → JSON → テスト を走らせます。

## 構成

```
index.html
css/            theme / phone / map / chat / apps
js/
  main.js       起動・画面の切り替え・ターンの進行
  constants.js  ASSET_BASE・localStorage キー
  data.js       JSON の読み込みと索引（db）
  state.js      newGame / save / load
  engine/       rng hex worldgen pathfind heroes economy orders battle ai turn season souls lines
  ui/           phone map-view chat-view calendar-view drive-view photo-view land-select-view result-view audio
data/           terrain facilities lands extensions messages heroes（生成物） enemies（生成物）
tests/          node --test
tools/          build-data.mjs sim.mjs smoke.mjs build-spec-index.mjs build-changelog.mjs
docs/           憲章・SPEC・原案・パターン
```

## ライセンス・素材

- MyCryptoHeroes の素材（ヒーロー・エネミー・エクステンション・ランド・背景・音）は MCH 社の許諾の範囲で、
  `bearko/mycryptoheroes` の raw URL を参照しています（このリポジトリには置きません）
- ヒーロー名・スキル名・エクステンション名・ランド名は MCH のものをそのまま使い、 独自の名称は作りません
