**Changed — MyCryptoWars への作り直し（原案の整理と MVP の仕様） (Phase 0)**

- 旧 MyCryptoTCG（カードバトル）のコード（`js/` `css/` `data/` `index.html` `MYCRYPTOTCG-KICKOFF.md` `tools/sim/`）を外し、 SPEC-100〜108 を Cancelled に
- 原案（企画構想）を `docs/concept.md` に残し、 MVP で作るもの・作らないものを SPEC-109 §12 の表で線引き
- 9 ランド（プレイヤー 1 + CPU 8）・28 日（4 週）のシーズン・砦ポイント（Rare 1 / Epic 3 / Legendary 10）・Legendary 攻略でクリア
- ヘックス（odd-r、 48 × 28、 東西ループ）、 緯度帯で地形 14 種（`data/terrain.json`）、 霧
- 資源 4 種（人口 / 食料 / GUM / 素材）と施設 6 種・ランク 3（`data/facilities.json`）
- ヒーローの 6 パラメーター（MCH の HP/PHY/INT/AGI から。 小数点以下は切り上げ）、 部隊 10 種、 MCH のパッシブスキル名
- コマンド 7 種（移動 / 占領 / 開拓 / 戦闘 / 内政 / 休息 / 方針）、 戦闘は 回避 → 防御 → ダメージ、 奇襲と反撃
- SOUL（3 体から 1 体）とエクステンション（マッチングアプリ風のスワイプ）
- スマホ UI（ホーム + MCH Map / Chat / Calendar / Drive / Photo）、 バッテリー = 残り日数
- 憲章（`PROJECT_CHARTER.md`）と README を MyCryptoWars に書き換え。 localStorage prefix を `mcw` に。 `ASSET_BASE` を `bearko/mycryptoheroes` の raw URL に（画像・音声はリポジトリに置かない）
- 用語: 通貨は GUM、 ヒーローが率いる兵は「部隊」（コードでは `squad`）。 実在のゲーム名・製品名は「参考作」と書く
- CI（`.github/workflows/ci.yml`）: 構文 → JSON → `node --test`
