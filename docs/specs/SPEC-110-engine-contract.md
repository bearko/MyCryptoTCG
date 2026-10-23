---
id: SPEC-110
title: エンジンの契約（state の形・純粋関数・ファイルの持ち主） (Phase 1)
status: Implementing
pr: ccr-3032454b-n1cx4z
phase: Phase 1
kind: Added
---

# SPEC-110 — エンジンの契約（アーキテクチャと、モジュール間の契約）

並列に作るための **契約**。ここに書いた名前・引数・戻り値・state の形は、**どのモジュールも勝手に変えない**。
変えたくなったら、この文書を先に直してから、呼ぶ側と呼ばれる側を同じ PR で直す。

- プレーン ES Modules + バニラ JS。ビルドなし、npm 依存なし（`package.json` は scripts だけ）
- `js/engine/*` は **DOM に触れない純粋関数**。`document` / `window` / `localStorage` を参照しない。
  乱数は必ず引数の `rng` を使う（`Math.random` 禁止）。テストは `node --test tests/*.test.mjs`
- `js/ui/*` が DOM を描く。状態は `app.state`（engine の state）と `app.ui`（画面だけの状態）
- データは `data/*.json` を実行時に `fetch`（`js/data.js`）。engine には **読み込んだ JSON を `db` として渡す**
- 画像・音声はリポジトリに置かず、`js/constants.js` の `img()`（`bearko/mycryptoheroes` の raw URL）で解決する

```
index.html
css/
  theme.css        色・フォント・共通部品（ボタン・シート・トースト）
  phone.css        スマホの外枠・ステータスバー・ホーム・アプリの切り替え
  map.css          Map アプリ（キャンバスの上の UI）
  chat.css         Chat アプリ
  apps.css         Calendar / Drive / Photo / 結果 / ランド選択
js/
  main.js          起動・画面の切り替え・ターンの進行（UI 側の司令塔）
  data.js          JSON の読み込みと索引（db）
  state.js         newGame / save / load / serialize
  engine/
    rng.js  hex.js  worldgen.js  pathfind.js  heroes.js  economy.js
    orders.js  battle.js  ai.js  turn.js  season.js  souls.js  lines.js
  ui/
    h.js           DOM ヘルパ（h, clear, on）
    phone.js       スマホの外枠・ステータスバー・ホーム・通知
    map-view.js    ヘックスの描画（canvas）・パン／ズーム・タップ・経路のプレビュー
    chat-view.js   メッセージアプリ風の指示
    calendar-view.js
    drive-view.js
    photo-view.js  エクステンション・スワイプ選択
    land-select-view.js  ランド選択（最初の画面）
    result-view.js
    audio.js       BGM / SE（既定 OFF）
data/
  terrain.json  facilities.json  lands.json  extensions.json  heroes.json（生成物）  enemies.json（生成物）  messages.json
tools/
  build-data.mjs   ../mycryptoheroes の JSON から data/heroes.json と data/enemies.json を作る
  smoke.mjs        playwright で実際に 3 ターン遊ぶ通しテスト
tests/*.test.mjs
docs/
```

---

## 1. データ（`data/*.json`）

### 1.1 `terrain.json`（手書き・固定）

```json
{ "id": "grass", "name": "草原", "moveCost": 1, "passable": true,
  "yield": { "food": 2, "gum": 1, "mat": 0 }, "buildable": true,
  "hpLoss": null | "summer" | "winter" | "always",
  "color": "#7cb342", "land": true }
```
`moveCost` は `passable: false` のとき無視。山岳・火山は `scoutCost: 3`（先鋒・偵察だけ通れるコスト）。

### 1.2 `facilities.json`（手書き・固定）

```json
{ "id": "farm", "name": "農地", "terrains": ["plain","grass","beach","desert"],
  "needsWater": false, "cost": { "gum": 20, "mat": 10 }, "days": 2,
  "effect": { "food": 4 } }
```
`effect` のキー：`food` `gum` `mat`（毎日の産出）、`popCap` `foodCap` `matCap`（上限）。
ランク n の効きは `effect × n`。

### 1.3 `lands.json`（手書き・固定）

9 ランド。`id` は MCH のランド名の小文字。

```json
{ "id": "ocean", "name": "Ocean", "nameJa": "オーシャン", "color": "#00d9d5",
  "icon": "Image/LandSectors/01_Ocean_3_Rare.png", "cryptid": "Image/Cryptids/01_Ocean.png" }
```
順番：ocean, strawberry, tangerine, lime, graphite, grape, sage, blueberry, ruby。
エネミー（砦の持ち主）は `"enemy"` という特別なランド id（`lands.json` には無い。engine が定数で持つ）。

### 1.4 `heroes.json`（`tools/build-data.mjs` の生成物。手で直さない）

```json
{ "id": 1001, "name": "コナン・ドイル", "nameEn": "Arthur Conan Doyle",
  "image": "Image/Heroes/1001.png", "rarity": 1, "faction": 3,
  "attributes": ["文系学問","イギリス","謎"],
  "stats": { "hp": 192, "phy": 25, "int": 69, "agi": 138 },
  "params": { "act": 13, "lead": 56, "str": 7, "int": 38, "gov": 35, "pol": 28 },
  "cls": { "main": "mid", "sub": "gunner" },
  "skill": { "name": "シャーロック・ホームズ", "kind": "buff", "text": "..." },
  "tone": "scholar" }
```
`rarity`：1 Common / 2 Uncommon / 3 Rare / 4 Epic / 5 Legendary。
`cls.main`：`front` | `mid` | `back`。`cls.sub`：`vanguard` `striker` `guard` `commander` `scout` `gunner` `support` `sniper` `caster` `healer`。
`skill.kind`：`damage` | `heal` | `buff` | `debuff`。
`tone`：`bushi` | `noble` | `scholar` | `rogue` | `plain`。

### 1.5 `enemies.json`（生成物）

砦の守備隊の「顔」に使う。`Image/Enemies/`（MCH リポジトリ） に画像があるものだけ。
```json
{ "id": 310, "name": "クリーパー ショート", "image": "Image/Enemies/101.png", "power": 20 }
```
`power` は `hp + phy + int + agi`（MCH の base_param）。砦のランクで `power` の帯を分けて選ぶ。

### 1.6 `extensions.json`（手書き・12 種）

```json
{ "id": "ext_boots", "name": "大西部のブーツ", "image": "Image/Extensions/4031.png",
  "effect": { "act": 1 }, "text": "行動力 +1" }
```
`effect` のキー：`act` `lead` `str` `int` `gov` `pol`（パラメーターへの加算）、`troopCap`（兵の上限 +n）、`vision`（視界 +n）。
画像は `Image/Extensions/`（MCH リポジトリ） にあるファイルから選ぶ（無いものを書かない）。

### 1.7 `messages.json`（手書き）

```json
{ "tones": ["bushi","noble","scholar","rogue","plain"],
  "messages": {
    "order.move.ack": { "bushi": "{dest}へ向かう。{days}日で着く見込みだ。", "noble": "...", "scholar": "...", "rogue": "...", "plain": "..." },
    ...
  } }
```
メッセージ ID の一覧は §6。`{name}` `{dest}` `{days}` `{ap}` `{troops}` `{target}` `{kind}` `{n}` を差し込める。

---

## 2. state（ゲームの状態。JSON にそのまま保存できる形）

```js
state = {
  version: 1,
  seed: 12345,                 // 数
  day: 1,                      // 1..28
  phase: "orders" | "execute" | "ended",
  playerLand: "ocean",
  map: { w: 48, h: 28, tiles: Tile[] },      // tiles[r * w + c]
  lands: { [landId]: Land },                 // 9 ランド + "enemy"
  squads: { [squadId]: Squad },                 // 全ランドのヒーロー部隊
  forts: { [fortId]: Fort },
  builds: { [tileIdx]: Build },              // 建築中
  nextId: 1,                                 // squadId / fortId の採番
  log: Event[],                              // 今ターンの実行フェーズのイベント（UI が読む）
  notices: Notice[],                         // ホームの通知（プレイヤー向け。実行後に積む）
  pending: Pending[],                        // プレイヤーの選択待ち（SOUL・エクステンション）
  ended: null | { reason: "clear"|"season"|"home_fallen"|"giveup", winner: landId|null }
}

Tile = { c, r, terrain: terrainId, owner: landId|null, fort: fortId|null,
         facility: null | { kind: facilityId, rank: 1|2|3 } }

Land = { id, cpu: boolean, alive: boolean,
         home: tileIdx, res: { pop, food, gum, mat },
         explored: number[],          // 探索済みタイルの index（重複なし・昇順でなくてよい）
         souls: Soul[],               // 未使用の SOUL
         extensions: extId[],         // 未装備のエクステンション
         fortPoints: 0,
         points: { week1: 0, week2: 0, week3: 0, week4: 0 } }

Soul = { role: "front"|"mid"|"back", rarity: 3|4|5, from: fortId }

Squad = { id: "s1", heroId: 1001, land: landId, tile: tileIdx,
         troops: 50, ap: 7,                     // ap は今ターンの残り
         orders: Order[], policy: "ignore"|"fight"|"ask",
         status: "ok"|"routed",                // routed: 敗走中（翌ターン AP 0）
         equip: extId|null,
         ambushed: false }                      // 奇襲された（翌ターン AP 半分）

Order = { type: "move", path: tileIdx[] }           // path[0] は今いるタイルを含まない
      | { type: "claim" }
      | { type: "build", kind: facilityId, rush: number }   // rush: 短縮に使う余りの AP
      | { type: "attack", target: tileIdx }
      | { type: "domestic", kind: "conscript"|"farm"|"trade"|"craft" }
      | { type: "rest" }
// queue は積んだ指示に、実際に引いた AP を `ap` として書き添える（{ ...order, ap }）

Fort = { id: "f1", rank: "rare"|"epic"|"legendary", tile: tileIdx, owner: landId|"enemy",
         troops: 60, durability: 40, maxDurability: 40, enemyId: 310, name: "Rare砦 ○○",
         stance: "intercept"|"defend",         // 砦に立っている味方部隊の守備方針。既定 "defend"
         fallenDay?: number }                  // 最後に落ちた日（turn.js が付ける。§7.4）。その日と翌日は攻められない

Build = { tileIdx, kind: facilityId, land: landId, daysLeft: 2, toRank: 1|2|3 }

Event = { t: "move", squad: squadId, from: tileIdx, to: tileIdx }
      | { t: "blocked", squad, at: tileIdx, reason: "ap"|"enemy"|"terrain"|"build"|"home"|"claim"|"target"|"range" }
      | { t: "claim", squad, tile: tileIdx, land }
      | { t: "build_start", squad, tile, kind, days }
      | { t: "build_done", tile, kind, rank, land }
      | { t: "battle", attacker: squadId, defender: squadId|fortId|landId, target: "squad"|"fort"|"home", at: tileIdx,
          ambush: boolean, evaded: boolean, dmg: number, skill: null|{ name, kind, value },
          counter: null|{ evaded, dmg, skill? },
          result: "hit"|"routed"|"fort_damaged"|"fort_fallen"|"home_damaged"|"home_fallen",
          followups: Event[] }
      | { t: "routed", squad, home: tileIdx }
      | { t: "fort_fallen", fort: fortId, by: landId, from: landId|"enemy" }
      | { t: "home_fallen", land: landId, by: landId, heroes: squadId[] }
      | { t: "soul", land, soul: Soul }
      | { t: "extension_offer", land, fort: fortId }
      | { t: "ask", squad, at: tileIdx, enemy: squadId|fortId }
      | { t: "domestic", squad, kind, amount }
      | { t: "rest", squad, amount }
      | { t: "yield", land, res: { pop, food, gum, mat } }
      | { t: "starve", land }
      | { t: "week_end", week: 1|2|3|4, points: { [landId]: number } }
      | { t: "clear", land }
      | { t: "season_end", winner: landId|null }

Notice = { id: number, day: number, kind: string, text: string, app: "map"|"chat"|"photo"|"drive"|null, tile: tileIdx|null }

Pending = { kind: "soul", land, soul: Soul, candidates: heroId[3] }
        | { kind: "extension", land, fort: fortId, candidates: extId[8] }
```

**タイルの index** は `r * w + c`。**部隊は 1 タイルに同じランドのものが何体いてもよい**が、
**敵ランドの部隊・敵の砦・敵の本拠地のタイルには入れない**（攻撃で解決する）。

`db`（`js/data.js` が返す）:
```js
db = { terrain: { [id]: Terrain }, facilities: { [id]: Facility }, lands: Land定義[],
       heroes: { [id]: Hero }, heroList: Hero[], enemies: Enemy[],
       extensions: { [id]: Ext }, messages: Messages }
```

---

## 3. engine の関数（純粋関数。`state` は引数で受け、**書き換えてよいのは「mutates」と書いたものだけ**）

### `rng.js`
- `makeRng(seed: number) → () => number`（0 以上 1 未満。mulberry32）
- `rngInt(rng, lo, hi) → number`（lo 以上 hi 以下）
- `pick(rng, arr) → item`
- `shuffle(rng, arr) → 新しい配列`
- `hashStr(s: string) → number`

### `hex.js`（odd-r オフセット。東西ループ）
- `idx(c, r, w) → number` / `col(i, w)` / `row(i, w)`
- `wrapC(c, w) → number`
- `neighbors(i, w, h) → number[]`（南北の端で欠ける。東西はループ）
- `distance(a, b, w, h) → number`（ループを考えた最短）
- `ring(i, radius, w, h) → number[]` / `within(i, radius, w, h) → number[]`（自分を含む）
- `latitude(r, h) → number`（度。北が正）
- `toPixel(c, r, size) → { x, y }`（pointy-top。描画用。ループは UI が処理する）
- `fromPixel(x, y, size) → { c, r }`

### `worldgen.js`
- `generateWorld(seed, db, landIds: string[]) → { map, homes: { [landId]: tileIdx }, forts: Fort[] }`
  - `map.tiles[i].owner` は本拠地の周囲 1 をそのランド、砦のタイルを `"enemy"` にして返す
  - 砦は Rare 6 / Epic 3 / Legendary 1。`enemyId` は `db.enemies` から `power` の帯で選ぶ
  - 本拠地は陸の `plain`/`grass` で、互いに 4 以上離す。Legendary は本拠地の群れの中心から経度で 180° 離れた陸
  - 陸が足りないなど失敗したら、seed + 1 で作り直す（最大 50 回）

### `pathfind.js`
- `stepCost(state, db, squad, hero, toIdx) → number | Infinity`（地形・部隊の種類・季節。敵のいるタイルは Infinity）
- `findPath(state, db, squad, hero, toIdx) → { path: tileIdx[], cost: number } | null`（A*。東西ループ）
- `reachable(state, db, squad, hero, ap) → Map<tileIdx, cost>`

### `heroes.js`
- `toParams(stats) → { act, lead, str, int, gov, pol }`（§spec 5.1。`Math.ceil`）
- `classify(stats, skillKind, attributes) → { main, sub }`
- `skillKindOf(passiveTextJa: string) → "damage"|"heal"|"buff"|"debuff"`
- `toneOf(attributes: string[], faction: number) → tone`
- `effectiveParams(hero, squad, db) → params`（装備の加算込み）
- `troopCap(hero, squad, db) → number`（`lead × 10 + 装備`）
- `visionOf(hero, squad, db) → number`（2。scout 3。装備で +）
- `rangeOf(hero) → number`（front 1 / mid 2 / back 3。caster・support・healer は 2）
- `subMods(sub) → { atk, def, actDelta, skillMult, healAdj }`（§spec 5.2 の係数）
- `starterHeroes(rng, db, landIndex) → heroId[3]`（Common〜Uncommon から front/mid/back を 1 体ずつ。他ランドと重ならないよう `usedIds: Set` を第 4 引数で受ける）

### `economy.js`
- `caps(state, db, landId) → { pop, food, mat }`
- `yields(state, db, landId) → { pop, food, gum, mat }`（占領タイル + 施設 + 街の隣接補正 + 自然増）
- `upkeep(state, db, landId) → { food }`（人口÷10 + 兵÷5）
- `applyDaily(state, db, landId) → Event[]`（**mutates**。産出 → 消費 → 上限 → 飢え。`yield` と `starve` のイベント）
- `canBuild(state, db, landId, tileIdx, kind, squad = null) → { ok: boolean, reason: string|null, cost: { gum, mat }, days: number, toRank: 1|2|3 }`
- `startBuild(state, db, squad, kind, rush) → Event`（**mutates**。費用を引き、`state.builds` に積む）
- `tickBuilds(state, db) → Event[]`（**mutates**。daysLeft を減らし、0 で施設に）
- `domestic(state, db, squad, kind) → Event`（**mutates**。§spec 6.5）
- `rest(state, db, squad) → Event`（**mutates**）

### `orders.js`
- `apCost(state, db, squad, order) → number`（move は path の合計。claim 1、build 2 + rush、attack 2、domestic 2、rest は残り全部）
- `validate(state, db, squad, order) → { ok, reason }`（本拠地にいるか、射程内か、建てられるか…）
- `queue(state, db, squadId, order) → { ok, reason }`（**mutates**。validate が ok なら `squad.orders` に積み、`squad.ap` から引く）
- `clearOrders(state, squadId)`（**mutates**。AP を戻す）
- `plannedAp(state, db, squad) → number`（積んだ指示の合計 AP）
- `apMax(hero, squad, db) → number`（act + 小分類の増減 + 装備。routed なら 0。ambushed なら半分）

### `battle.js`
- `power(state, db, squad) → { atk, def }`
- `fortPower(state, db, fort) → { atk, def }`
- `isAmbush(state, db, attacker, defenderSquadOrFort) → boolean`（防御側の視界に攻撃側がいないか）
- `resolve(state, db, rng, attackerSquad, target) → Event(t:"battle")`（**mutates**。target は Squad か Fort か本拠地タイル `{ home: landId }`。§spec 7.2 の順で解決し、敗走・陥落まで state に反映する。陥落時は `fort_fallen` / `home_fallen` / `soul` / `extension_offer` のイベントを `event.followups: Event[]` に入れて返す）
- `inRange(state, db, squad, targetTile) → boolean`

### `ai.js`
- `plan(state, db, rng, landId)`（**mutates**。そのランドの全部隊に `orders.queue` で指示を積む。§spec 7.3）

### `turn.js`
- `beginTurn(state, db)`（**mutates**。`phase = "orders"`、各部隊の `ap = apMax`、`orders = []`、`ambushed` を消費、`routed` の復帰、`log = []`）
- `planCpu(state, db, rng)`（**mutates**。CPU の全ランドに `ai.plan`）
- `execute(state, db, rng) → Generator<Event>`（**mutates**。`phase = "execute"`。ラウンド制で 1 歩ずつ yield。最後に `applyDaily`・`tickBuilds`・霧・回復・日曜の集計・終了判定。`state.log` にも全イベントを積む）
- `finishDay(state, db) → Event[]`（execute の末尾が呼ぶ。単体でもテストできるように分ける）
- `revealFog(state, db, landId)`（**mutates**。全部隊の視界 + 本拠地の周囲 3 + 占領タイルの周囲 1）
- `noticesFrom(state, db, events) → Notice[]`（プレイヤーのランドに関係するものだけ日本語に）

### `season.js`
- `weekOf(day) → 1..4` / `seasonOf(day) → "spring"|"summer"|"autumn"|"winter"` / `dayOfWeek(day) → 0..6`（0 が月曜。6 が日曜）
- `fortPoints(rank) → 1|3|10`
- `tallyWeek(state) → Event(t:"week_end")`（**mutates**。`fortPoints` と `points.weekN`）
- `checkEnd(state, db) → null | { reason, winner }`
- `score(state, db, landId) → { total, breakdown: { fortPoints, tiles, heroes, facilities, clear, daysLeft } }`
- `battery(day) → number`（残り日数 ÷ 28 を 0..100 の整数）

### `souls.js`
- `candidates(rng, db, soul, usedHeroIds: Set) → heroId[3]`（soul.role の大分類・soul.rarity。10% で +1 段。足りなければ隣のレアリティで埋める）
- `accept(state, db, landId, pending, heroId) → Squad`（**mutates**。本拠地に部隊を作る。兵は lead × 3。`state.pending` から外す）
- `extensionCandidates(rng, db, land) → extId[8]`
- `acceptExtension(state, db, landId, pending, liked: extId[]) → extId`（**mutates**。liked からランダム。空なら candidates からランダム。`land.extensions` に足す）
- `equip(state, db, squadId, extId|null)`（**mutates**。付け替え。外したものは `land.extensions` へ戻る）

### `lines.js`
- `say(db, hero, msgId, vars) → string`（口調ごとの文言に `{name}` などを差し込む。無い ID は `msgId` をそのまま返す）

### `state.js`
- `newGame({ seed, playerLand, db }) → state`（worldgen → 9 ランド → starter 3 体ずつ → 砦 → 霧 → `beginTurn`）
- `serialize(state) → string` / `deserialize(json) → state`
- `save(state)` / `load() → state|null`（ここだけ `localStorage` を触ってよい。engine からは呼ばない）

---

## 4. UI（`js/ui/*`、`js/main.js`）

- `app = { db, state, ui: { app: "home"|"map"|"chat"|"calendar"|"drive"|"photo"|"land"|"result", selectedSquad, chatSquad, mapCam: { x, y, zoom }, ... }, rng }`
- `main.js`：`boot()` → `load()` があれば続き、無ければランド選択 → `go(appName)` で画面切り替え →
  `endTurn()`：`planCpu` → `execute` の generator を `requestAnimationFrame` で 1 歩 0.35 秒（スキップで 0）
  → 終わったら `noticesFrom` を積み、`pending` があれば Photo（スワイプ）／Drive（SOUL）へ誘導 → `beginTurn` → `save`
- 各ビューは `render(app) → HTMLElement` と、必要なら `mount(app, el)` / `unmount()` を export
- `map-view.js` は `<canvas>` に描く。1 ヘックスの大きさは `app.ui.mapCam.zoom × 28px`。
  東西ループは、カメラの位置に合わせて **タイルを 2 周ぶん描く**（左右に繋がって見える）
- **音は既定 OFF**。鳴らしても報酬や結果は変わらない

---

## 5. ファイルの持ち主（並列に作るときの衝突を避ける）

| 持ち主 | 書いてよいファイル |
|---|---|
| map 班 | `js/engine/hex.js` `worldgen.js` `pathfind.js` `tests/hex.test.mjs` `tests/worldgen.test.mjs` `tests/pathfind.test.mjs` |
| heroes 班 | `js/engine/rng.js` `heroes.js` `souls.js` `tools/build-data.mjs` `data/heroes.json` `data/enemies.json` `data/extensions.json` `tests/heroes.test.mjs` `tests/souls.test.mjs` |
| economy 班 | `js/engine/economy.js` `orders.js` `tests/economy.test.mjs` `tests/orders.test.mjs` |
| battle 班 | `js/engine/battle.js` `tests/battle.test.mjs` |
| turn 班 | `js/engine/ai.js` `turn.js` `season.js` `js/state.js` `js/data.js` `tests/turn.test.mjs` `tests/season.test.mjs` |
| lines 班 | `js/engine/lines.js` `data/messages.json` `tests/lines.test.mjs` |
| UI 班 | `js/ui/*` `css/*` `js/main.js` `index.html` |

`data/terrain.json` `facilities.json` `lands.json` は固定（この契約と一緒に書いた）。

---

## 6. メッセージ ID（`data/messages.json`）

| ID | いつ | 差し込み |
|---|---|---|
| `greet.morning` | 指示フェーズの始まり（Chat を開いたとき） | name, day |
| `order.move.ack` | 移動を積んだ | dest, days |
| `order.claim.ack` | 占領を積んだ | – |
| `order.build.ack` | 開拓を積んだ | kind, days |
| `order.attack.ack` | 戦闘を積んだ | target |
| `order.domestic.ack` | 内政を積んだ | kind |
| `order.rest.ack` | 休息を積んだ | – |
| `order.policy.ack` | 方針を変えた | kind |
| `order.reject.ap` | AP が足りない | ap |
| `order.reject.home` | 本拠地にいない（内政） | – |
| `order.reject.range` | 射程外 | – |
| `order.reject.build` | 建てられない | kind |
| `report.arrived` | 目的地に着いた | dest |
| `report.blocked` | 途中で止まった | – |
| `report.win` | 戦闘に勝った | target |
| `report.lose` | 戦闘に負けた | target |
| `report.routed` | 敗走した | – |
| `report.ambush` | 奇襲を受けた | – |
| `report.ambushed_them` | 奇襲に成功した | target |
| `report.fort` | 砦を落とした | target |
| `report.ask` | 指示を仰いでいる | – |
| `report.build_done` | 建築が終わった | kind |
| `report.domestic` | 内政の結果 | kind, n |
| `join` | 仲間になった | name |
| `idle` | AP が余ったままターンを終えた | ap |

口調は 5 つ全部に文言を書く（抜けていたら `plain` を使う）。

---

## 7. 実装で決めたこと（各班の報告から。ここに書いたものは契約に含める）

### 7.1 state・データ
- Squad の id は `"s" + state.nextId++`（s1, s2, ...）。砦の id は worldgen が付ける `f1`〜`f10`。接頭辞が違うので `nextId` は 1 から始める
- `lands.enemy` は `{ id: "enemy", cpu: true, alive: true, home: null, res: すべて 0, ... }`。産出・霧・集計の対象にしない
- `Land.homeDurability`（任意。無ければ 100）。本拠地の耐久。落ちると 0
- 開始時の部隊の policy は、プレイヤーが `"ask"`、CPU が `"fight"`（CPU は ai.plan が毎ターン fight にする）
- `data/terrain.json` `facilities.json` の通貨のキーは `"gum"`
- `db` は `js/data.js` の `buildDb`：terrain・facilities・heroes・extensions は配列から id の辞書にする。`loadDb(base)`（fetch）と `loadDbFromFs(dir)`（node:fs を動的 import）

### 7.2 orders / economy
- `canBuild` の第 6 引数 `squad`（任意）。渡すと日数は `max(1, days − floor(統治力 / 10))`。reason：tile / kind / owner / fort / terrain / water / other / rank / building / gum / mat
- `queue` は指示を `{ ...order, ap }` で積む（`ap` は実際に引いた AP。clearOrders がこれで戻す）
- `startBuild` は、実行時に建てられなくなっていれば state を変えず `{ t: "blocked", reason: "build" }` を返す

### 7.3 battle
- CPU のランドが砦を落としたときは `state.pending` を作らず、その場で受け取る（SOUL は候補の先頭、エクステンションはおまかせ）。`soul` / `extension_offer` のイベントは followups に入る
- 本拠地を攻めたとき、守備部隊がいなければ `defender` は landId（`target: "home"` で見分ける）
- Legendary が落ちると followups に `clear` が入る。`state.ended` を付けるのは turn.js（season.checkEnd）
- 追加の export：`ENEMY_LAND` `FORT_LEAD` `HOME_MAX_DURABILITY` `HOME_LEAD` `homePower`

### 7.4 turn（実行フェーズ）
- `beginTurn`：全部隊の `orders = []`、`ap = apMax`。routed の部隊はこの日 AP 0 で、`status = "ok"`・兵 lead × 3 に戻る。`ambushed` はこの日の AP を半分にして消す
- `execute` の始めに全部隊の `ap` を **その日の AP**（残りの `ap` ＋ 積んだ指示の `ap` の合計。`apMax` で頭打ち）に戻し、実行中は実際のコストを引く（AP が足りなければ blocked(ap) で残りの指示を捨てる）。
  `apMax` を呼び直してはいけない：beginTurn が `ambushed` と `routed` をもう消しているので、奇襲された部隊（AP 半分）と敗走明けの部隊（AP 0）が満タンで動いてしまう（検証班が修正。`tests/verify.test.mjs`）
- ラウンドごとに部隊の順番を rng で混ぜ、各部隊の `orders[0]` を 1 歩進める。move は 1 タイル、ほかの指示は 1 回で終わる。上限は `MAX_ROUNDS = 120`。最後に残った指示は捨てる
- move の path は書き換えず、`orders[0]` を残りの path で作り直す（呼ぶ側の配列を共有していることがあるため）
- 接敵：次のタイルに敵（部隊・砦・本拠地）がいるとき、または途中の歩み（最後の 1 歩を除く）で敵ランドの部隊と隣り合ったとき。
  ignore は進む（塞がれていれば blocked(enemy)）。fight は `battle.resolve`（同じ相手とは 1 日 1 回。射程外なら blocked(enemy)）。ask は残りの指示を捨てて `ask` イベント
- 実行時の再検査で失敗した指示は、その指示だけを捨てる（claim / target / range / home / build）か、残りを全部捨てる（ap / enemy / terrain）
- `targetAt(state, landId, tile)`（追加の export）：攻撃の対象を 本拠地 → 砦 → 部隊（兵の多い順）で探す。本拠地に立つ部隊を狙っても、本拠地への攻撃として解決する
- **落ちた砦は、落ちた日と翌日は攻められない**（blocked(target)。fight の接敵でも戦わない）。陥落直後の砦は守備兵 30 なので、持ち主が毎日入れ替わっていた（1 シードで 100 回前後）。
  陥落したとき turn.js が `Fort.fallenDay = state.day`（任意の項目。無ければ一度も落ちていない）を付け、`isShielded(state, fort)`（`state.day − fallenDay ≤ FORT_SHIELD_DAYS`、`FORT_SHIELD_DAYS = 1`）で見る。どちらも turn.js の追加の export。砦を狙う UI もこれで見分けられる
- 体力減の地形に入ると兵が減る：季節が合えば −3%、always は −1%（兵が 1 以上なら 1 は残す）
- battle の `followups` は、battle イベントのあとに 1 つずつ yield し、`state.log` にも積む（battle イベントの中にも残る）
- Legendary の攻略・プレイヤーの本拠地の陥落で、ラウンドの途中でも止めて `season_end` を出す（finishDay はしない）
- `finishDay`：applyDaily（各ランド）→ tickBuilds → 回復（support / healer の隣の同じランドの部隊は 兵の上限 × healAdj、本拠地にいる部隊は +lead。上限まで）→ revealFog → 日曜なら tallyWeek → `day += 1` → checkEnd。終わったら `state.ended`・`phase = "ended"`・`day` は 28 に留める
- `noticesFrom` は battle の followups を見ない（execute が別に流すので二重になる）。占領はまとめて「n タイルを占領しました」。Notice の id は `state.notices` の最大 + 1 から

### 7.5 season
- `checkEnd` は `state.ended` があればそれを返す（ギブアップは UI が `state.ended = { reason: "giveup", winner: null }` を付ける）。
  次に Legendary の持ち主 → プレイヤーの alive → `day > 28`（= 28 日目の集計後）の順。home_fallen の winner は null。season の同点（砦ポイントも占領数も同じ）も null
- `score` の breakdown は各項目の点（足すと total）。元の数は `counts` に入れる
- `battery(day)` は その日を含む残り日数 ÷ 28（1 日目 100、28 日目 4、29 日目 0）
- 追加の export：`tileCount` `seasonWinner`

### 7.6 ai
- **留守番**：食料の収支（産出 − 消費。今日の休息・徴兵で増える兵も見込む）が足りなければ、本拠地に近い部隊（AP 4 以上。同じ距離なら攻撃力の低いもの）から、明日の不足を農作で埋められるまで留守番にする。最低 1 体は外に残す。
  留守番は戦わず、本拠地へ戻って農作（食料の上限まで）→ GUM・素材が乏しければ商業・工作 → 本拠地の隣に農地（ランクの上がるもの・草原を先に）か、上限が足りなければ食料庫を建てて、そのタイルで夜を越す。
  本拠地で夜を越すと兵が lead 回復して消費が増えるため（兵が上限の 3 割未満のときだけ本拠地に残る）。SPEC-109 §4 の数値は変えていない
- **砦の守り**：自ランドの砦に立っている部隊は動かない（1 砦 1 体）。守り手のいない砦には、4 以内の部隊が入る（砦を落とした攻め手がそのまま入る）。全員が張り付いたら、いちばん兵の多い守り手を攻めに出す
- **攻め手**：残りの上位（3 体以上なら半分、それ未満は 1 体）。いちばん近い（経路のコスト）未所有の砦へ向かい、射程内なら攻める。
  Epic・Legendary は距離を割り引いて選び（`FORT_BONUS`：Epic 6 / Legendary 10）、兵が下限（`FORT_MIN_TROOPS`：Epic 200 / Legendary 550）に満たなければ、本拠地に戻って休息で兵を増やしてから向かう（1 日に 1 体まで。増える兵の消費が食料の上限に収まるときだけ）。
  他ランドの砦は 12 遠く見て、落ちたばかりのもの（`isShielded`）と、守り手の兵が自分の 1/1.5 を超えるものは狙わない
- 砦に立っている部隊は「射程内の弱い敵」として撃たない（撃つと砦への攻撃になるため。砦は上の基準で選ぶ）
- CPU は本拠地に立っている部隊を攻めない（本拠地の攻略になり、ランドを脱落させてしまうため）。MVP では CPU が本拠地を狙うことは無い

