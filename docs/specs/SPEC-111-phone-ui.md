---
id: SPEC-111
title: スマホ UI（ホーム + MCH Map / Chat / Calendar / Drive / Photo）と実行フェーズの演出 (Phase 2)
status: Implementing
pr: ccr-3032454b-n1cx4z
phase: Phase 2
kind: Added
---

# SPEC-111 — スマホ UI と実行フェーズの演出

SPEC-109 §8 の画面を実装する。 エンジンの契約は SPEC-110。 **UI はエンジンの関数を呼ぶだけで、
ゲームのルールを UI 側に書かない**（数値・判定は `js/engine/*` にしかない）。

## 1. 画面の一覧

| id | 画面 | 中身 |
|---|---|---|
| `land` | ランド選択 | 9 枚のカード（ランドの色・ランドセクタのアイコン・クリプタイド）。 1 枚タップで `newGame` |
| `home` | ホーム | ステータスバー + アプリのアイコン 5 つ + 通知の一覧 + 「ターン終了」 |
| `map` | MCH Map | ヘックスマップ（canvas）。 下に情報シート。 右下に「ターン終了」 |
| `chat` | MCH Chat | 左（または上）にトークの一覧、 右（または下）にトークとリッチメニュー |
| `calendar` | MCH Calendar | 28 日のカレンダーと予定 |
| `drive` | MCH Drive | ヒーロー / 砦とエネミー / ランド のタブ |
| `photo` | MCH Photo | エクステンションの一覧と装備。 スワイプ選択 |
| `execute` | 実行フェーズ | Map の上に 1 歩ずつ演出。 右上に「スキップ」 |
| `result` | 結果 | スコアの内訳・順位・「もう一度」 |

ポップアップ（1 つずつ。 重ねない）: SOUL の 3 体選択、 タイルの情報シート、 ギブアップの確認、 設定（音）。

## 2. スマホの外枠（`js/ui/phone.js`、 `css/phone.css`）

- `#app` の中に `.phone`（最大幅 480px、 高さ 100dvh、 中央寄せ。 880px 以上では左右に余白）
- **ステータスバー**（上 28px）: 左に `Day 7 ・ 日 ・ 夏`（`season.dayOfWeek` / `seasonOf`）、 右に **バッテリー**
  （`season.battery(day)` を % とアイコンで。 20% 以下は赤）。 **数字はすべて `tabular-nums`**
- **ホーム**: アプリのアイコンは 5 つ（Map / Chat / Calendar / Drive / Photo）を 3 列で。 アイコンは文字と
  単色の図形（絵文字は使わない。 CLAUDE.md）。 未読の通知・選択待ち（`state.pending`）があるアプリに **バッジ**
- 通知（`state.notices`）は新しい順に。 タップすると `notice.app` の画面へ（`notice.tile` があれば Map でそこへ寄る）
- 画面の切り替えは `main.js` の `go(app)`。 下の **ホームボタン**（戻る）はどの画面にも出す
- **「ターン終了」** はホームと Map に。 押すと `endTurn()`。 選択待ち（`pending`）が残っていれば先にそちらへ誘導する

## 3. MCH Map（`js/ui/map-view.js`、 `css/map.css`）

- `<canvas>` に描く。 1 ヘックスの大きさ `size = 28 × zoom`（zoom 0.5〜2.5）。 `hex.toPixel` / `fromPixel`
- **東西ループ**: カメラの x に合わせてタイルを 2 周ぶん描き、 左右が繋がって見える
- 描くもの（下から）: 地形の色（`terrain.color`）→ 占領地の色（ランドの `color` を 35% で重ねる）→ 未探索は黒 80%
  （`land.explored` に無いタイル）→ 施設（小さな記号 + ランク）→ 砦（ランクの色の枠 + エネミーの絵）→ 本拠地
  （ランドセクタのアイコン）→ 部隊（ヒーローの絵 64px を `image-rendering: pixelated`。 敵は赤い縁）→ 選択中・経路
- **操作**: ドラッグでパン、 ホイール / ピンチでズーム、 タップでタイルを選ぶ（ドラッグ 6px 以上はタップにしない）
- **情報シート**（下から出る。 画面の 40% まで）: 地形名・産出・持ち主・施設・砦（守備兵 / 耐久）・そこにいる部隊
  （ヒーロー名・兵・残り AP）。 自分の部隊をタップすると **選択** になる
- **経路**（地図アプリの経路）: 部隊を選んだ状態で別のタイルをタップすると `pathfind.findPath` で経路を引き、
  **所要日数**（AP を超える分は翌日以降に持ち越し。 `Math.ceil(cost / apMax)`）と「この経路で行く」 を出す。
  押すと `orders.queue(move)`。 敵の砦・部隊・本拠地なら「攻略」「攻撃」 に変わり `orders.queue(attack)`
  （射程外なら 「射程 n に入っていません」）
- 選んだ部隊の **到達範囲**（`pathfind.reachable`）を薄く塗る
- 右上に **「表示」** の切り替え: 産出 / 持ち主 / 霧を消す（デバッグ用。 `?debug=1` のときだけ）
- 画像は `img()` で。 読み込み前・失敗時は地形の色だけで描く（`onerror` で代替）

## 4. MCH Chat（`js/ui/chat-view.js`、 `css/chat.css`）

- **トークの一覧**: 自分のヒーロー（64px の絵・名前・最後のセリフ・残り AP）。 上に **マインちゃん**（ホームの通知と同じ内容を話す）
- **トーク**: 吹き出し。 ヒーローの吹き出しは左（`lines.say(db, hero, msgId, vars)` の文）、 自分の指示は右。
  `greet.morning` はトークを開いたときに 1 回
- **リッチメニュー**（下。 2 行 × 4 列）: 移動 / 占領 / 開拓 / 戦闘 / 内政 / 休息 / 方針 / 取り消し
  - 移動 → 「Map で目的地を選ぶ」（Map へ移って選択状態にする）
  - 占領 → `orders.queue(claim)`
  - 開拓 → 施設 6 種のボタン（`economy.canBuild` の結果で 費用・日数・ランク を添え、 建てられないものは理由つきで disabled）
    → 「余った AP で短縮する」 のトグル
  - 戦闘 → 射程内の敵（部隊 / 砦 / 本拠地）のボタン → `orders.queue(attack)`
  - 内政 → 徴兵 / 農作 / 商業 / 工作（本拠地にいないときは `order.reject.home` のセリフ）
  - 休息 → `orders.queue(rest)`
  - 方針 → 無視 / 戦闘 / 指示を仰ぐ（`squad.policy` を直接変える）
  - 取り消し → `orders.clearOrders`
  - 指示が通ったら `order.<type>.ack` のセリフ、 通らなければ `order.reject.*` のセリフ
- トークの上に **積んだ指示の一覧**（例: 移動 3 → 占領 → 開拓 農地）と 残り AP / AP 上限
- 文字入力は無い（選択式だけ）

## 5. MCH Calendar（`js/ui/calendar-view.js`）

- 7 列 × 4 行。 今日を強調。 過ぎた日はグレー
- 日ごとの予定: 建築の完成（`state.builds` の `daysLeft`）、 移動の到着（積んだ move の所要日数）、 日曜の集計、 季節の変わり目（8 日目 夏 / 15 日目 秋 / 22 日目 冬）、 28 日目 「バッテリー切れ」
- 日をタップすると、 その日の予定の一覧

## 6. MCH Drive（`js/ui/drive-view.js`）

- タブ: **ヒーロー** / **砦とエネミー** / **ランド**
- ヒーロー: 自分の部隊ごとに 絵・名前・レアリティ（`data-rarity`）・部隊の種類（大分類 / 小分類）・6 パラメーター（棒グラフ）・スキル（名前と種類）・兵 / 上限・装備
- 砦とエネミー: 探索済みの砦（ランク・持ち主・守備兵・耐久・エネミーの絵と名前）。 未探索は「？」
- ランド: 9 ランドの砦ポイント・占領タイル数・ヒーロー数（分かる範囲。 探索済みの情報だけ）
- **SOUL の選択**（`pending.kind === "soul"`）はここ: 3 体のカードを横に並べ、 1 体タップ → 確認 → `souls.accept`

## 7. MCH Photo（`js/ui/photo-view.js`）

- 持っているエクステンション（`land.extensions`）を写真のグリッドで。 タップで詳細 → 「装備する」（部隊を選ぶ）/ 「捨てる」（確認つき）
- 装備中のものは部隊の名前つきで別の段に
- **スワイプ選択**（`pending.kind === "extension"`）: 8 枚のカードが重なって出る。 **右へはらう = アリ、 左 = ナシ**。
  指でもマウスでも矢印キーでも。 踏み切る前（56px 未満）で放せば戻る。 途中まで動かすとその側が光る。
  上に **10 秒のタイマー**（`setTimeout` は UI 側。 残り時間は演出だけで報酬を変えない）。
  時間切れか 8 枚終わったら `souls.acceptExtension(liked)` → 手に入ったものを大きく出す

## 8. 実行フェーズ（`main.js` の `endTurn()`）

1. `pending` が残っていれば誘導して止める
2. `turn.planCpu(state, db, rng)`
3. `turn.execute(state, db, rng)` の generator を 1 歩 350ms で進め、 Map の上に描く
   - `move`: 部隊の絵がタイル間を滑る。 カメラは自分の部隊のときだけ追う
   - `battle`: 攻撃側と防御側の間に **ダメージの数字が浮く**。 奇襲は「奇襲！」、 回避は「回避」。 砦の耐久バーが減る
   - `fort_fallen` / `home_fallen` / `clear`: 画面中央に帯で 1.2 秒
   - その他（`claim` `build_*` `domestic` `rest` `yield` `week_end`）: 右上に小さなトースト。 連続するものは 1 つにまとめる
   - **「スキップ」** で残りを待たずに最後まで進める（generator を同期で回し切る）
4. 終わったら `turn.noticesFrom` でホームの通知を積む → `state.ended` なら `result` へ → そうでなければ `turn.beginTurn` → `save` → ホームへ

## 9. 結果（`js/ui/result-view.js`）

- 理由（クリア / バッテリー切れ / 本拠地の陥落 / ギブアップ）と、 9 ランドの砦ポイントの順位
- `season.score` の内訳を 1 行ずつ **数字が転がる** 演出で（1.5 秒以内）
- 「もう一度」 → `land` へ（セーブは消す）。 トークンやランキングは出さない（MVP の外）

## 10. 共通の決まり

- **CSS**: `css/theme.css`（DESIGN_CHARTER のパレット。 `--accent` は金。 9 ランドの色はデータから `style` で）/
  `phone.css` / `map.css` / `chat.css` / `apps.css`。 `@media` は 3 つまで、 中間は `clamp()`
- **z-index**: 0-4 マップ / 10-90 通常 UI / 100 トースト / 120 ポップアップの背景 / 150 帯（砦の陥落など）/ 200 ランド選択 / 1000 起動
- **ポップアップは 1 つずつ**。 閉じる方法は 3 つ（閉じる・背景タップ・Esc）。 `role="dialog" aria-modal="true"`
- **`img` には `alt`**。 ボタンには `focus-visible` の枠。 コントラスト 4.5:1
- **絵文字を使わない**。 アイコンは文字・単色の図形・MCH の画像（`Image/BattleIcons/*` など）
- **UI 文言は `lines.uiText(db, key)`**（`data/messages.json` の `ui`）か、 `data/i18n/ui.json` の `ja`。 MVP は日本語のみ
- **音は既定 OFF**（設定で ON）。 BGM は `Audio/BGM/land.mp3`、 戦闘中は `land-battle.mp3`。 鳴らしても結果は変わらない
- `prefers-reduced-motion` のときは滑る・転がる演出を省く
- **ゲームのルールを UI に書かない**。 AP の計算・建てられるか・射程・報酬は全部エンジンに聞く

## 11. 通しテスト（`tools/smoke.mjs`）

Playwright（Chromium）で `python3 -m http.server` を立てて開き、 ランドを選ぶ → Chat で 3 体に指示 → ターン終了 →
実行の演出をスキップ → ホームに戻る、 を 3 ターン回して Console エラーが 0 であることを見る。
CI では走らせない（Playwright が要る）。 手元で走らせる。
