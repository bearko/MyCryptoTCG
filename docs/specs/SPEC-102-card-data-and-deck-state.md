---
id: SPEC-102
title: カードデータ JSON + デッキ state + cards/deck モジュール (Day 1 Phase 1A)
status: Implementing
pr: claude/import-kickoff-document-bQ6rP
phase: Phase 1A
kind: Added
---

# SPEC-102 — カードデータ JSON + デッキ state + cards/deck モジュール

## 1. 目的

`MYCRYPTOTCG-KICKOFF.md` 5 章で示された Day 1 MVP の **データ層** を起こす:

- 3 体の MCH ヒーロー (= heroId 1001/1002/1003) を TCG カード定義として JSON 化
- デッキ / 手札 / ストーン / マスター HP / 場 の **バトル side state 構造体** を定義
- 純粋関数群: `shuffleDeck` / `drawCard` / `peekCard` / `isDeckEmpty`
- バトル初期化: `initBattle(playerDeckIds, cpuDeckIds)` で `state.battle` を確立

UI / ターン進行 / 召喚アニメ等は **本 SPEC のスコープ外**。 ロジック層の最下層
だけを Phase 1A として閉じる。

## 2. スコープ

### In Scope (= この SPEC で触る)

- `data/cards/heroes.json` 新規 (= 3 体、 MCH 公式名 + 公式 passive スキル名)
- `js/battle/cards.js` 新規 (= `loadCardDb()` / `getHeroDef()`)
- `js/battle/deck.js` 新規 (= shuffle / draw / peek / isDeckEmpty)
- `js/battle/battle-state.js` 新規 (= `newBattleSide()` / `initBattle()` / `getBattle()` + 定数)
- `js/state.js` 拡張: `state.battle = null` を初期化フィールドとして追加
- `js/main.js`: デバッグ用 `window.__testBattle` を追加 (= 後続 SPEC のロジック層検証用)

### Out of Scope (= この SPEC では触らない)

- マジックカード / エクステンションカード (= スコープ縮約。 Day 2 以降の SPEC で扱う)
- スキルエフェクトの実装ロジック (= effect string 解釈は Phase 1B SPEC-103 で)
- 召喚酔い / 攻撃判定 / マスター被弾 (= Phase 1B SPEC-103)
- UI 描画 (= Phase 1C SPEC-104)
- スプライト (= Phase 1D SPEC-105)

## 3. 採用ヒーロー 3 体 (= MCH master DB から引用)

`https://raw.githubusercontent.com/bearko/mycryptoheroes/main/Data/Heroes/heroes.json`
より、 先頭の 3 体を採用:

| MCH heroId | name.ja | name.en | faction | rarity | passive (MCH 公式) |
|---|---|---|---|---|---|
| 1001 | コナン・ドイル | Arthur Conan Doyle | 玄武 (GENBU) | Common | シャーロック・ホームズ |
| 1002 | 甲斐姫 | Kaihime | 朱雀 (SUZAKU) | Common | 浪切 |
| 1003 | 張遼 | Zhang Liao | 白虎 (BYAKKO) | Common | 遼来遼来 |

3 派閥カバー + 全 Common = Day 1 デモバランスとして適切。

### 3-1. カードパラメータ (= TCG 用の正規化値)

MCH の max level stats を TCG 用 `cost / hp / atk` にゲームバランス調整:

| heroId | role | cost | hp | atk | row | スキル効果 (= Phase 1B で実装) |
|---|---|---|---|---|---|---|
| 1001 | 後衛サポート | 2 | 2 | 2 | back | `ally_atk_plus_1` (= 味方 ATK+1 ターン) |
| 1002 | 前衛アタッカー | 3 | 3 | 3 | front | `damage_plus_1` (= 自身の通常攻撃 +1) |
| 1003 | 前衛タンク | 4 | 5 | 2 | front | `self_def_plus_1` (= 被弾 -1、 1 ターン) |

`row` は MCT 縮約版の **front (= 前衛) / back (= 後衛)** に対応 (= KICKOFF 2-1 で 2x2
から 2 体に縮約した方針)。 スキル `effect` の文字列キーは Phase 1B `js/battle/effects.js`
で解釈される予定。

### 3-2. portraitUrl

各カードに **MCH 公式の 64×64 ポートレート URL** を `portraitUrl` で持たせる
(= Phase 1C UI 描画用)。 SPEC-105 のスプライトシートとは別物 (= 静止画 fallback
としても使う)。

```
https://raw.githubusercontent.com/bearko/mycryptoheroes/main/Image/Heroes/<heroId>.png
```

## 4. データ構造

### 4-1. `data/cards/heroes.json`

```json
[
  {
    "id": "mch_1001",
    "type": "hero",
    "mchHeroId": 1001,
    "name": { "ja": "コナン・ドイル", "en": "Arthur Conan Doyle" },
    "faction": "GENBU",
    "rarity": "Common",
    "cost": 2,
    "hp": 2,
    "atk": 2,
    "row": "back",
    "skills": [
      {
        "id": "sherlock_holmes",
        "name": { "ja": "シャーロック・ホームズ", "en": "Sherlock Holmes" },
        "mchPassiveId": 1104,
        "cost": 1,
        "effect": "ally_atk_plus_1"
      }
    ],
    "sprite": "1001",
    "portraitUrl": "https://raw.githubusercontent.com/bearko/mycryptoheroes/main/Image/Heroes/1001.png"
  },
  ...
]
```

`type: "hero"` で TCG 内のカード種別 (= 将来 magic / extension を足す前提)。
`sprite` は SPEC-105 で `assets/sprites/heroes/<sprite>/idle.png` を解決する key。

### 4-2. バトル side state

```js
{
  deck: [/* card id 文字列の配列 (= 残り山札、 先頭が next draw) */],
  hand: [/* card id */],
  stones: 0,        // 現在保有ストーン
  masterHp: 10,     // マスター HP (= ストーン換算)
  field: {
    front: null,    // フィールドの card インスタンス (= Phase 1B 拡張)
    back: null,
  },
}
```

`field.front` / `field.back` は Phase 1A では **null のみ**。 召喚処理は Phase 1B
SPEC-103 で `{ heroId, currentHp, summoningSick, ...}` を入れる形に拡張する。

### 4-3. `state.battle`

```js
state.battle = {
  cardDb: { heroes: [...] },
  player: { /* side state */ },
  cpu: { /* side state */ },
  turn: "player",     // "player" / "cpu"
  turnNumber: 0,
  phase: "preStart",  // "preStart" / "draw" / "refill" / "action" / "end"
};
```

`state.battle = null` がデフォルト (= バトル外)。

## 5. 公開関数

### `js/battle/cards.js`

```js
export async function loadCardDb(): Promise<CardDb>
export function getHeroDef(cardDb, id): HeroDef | undefined
```

### `js/battle/deck.js`

```js
export function shuffleDeck(deck): void   // in-place Fisher-Yates
export function drawCard(side): string | null   // deck → hand 移動、 ID を返す
export function peekCard(side): string | null   // deck の先頭を read-only で見る
export function isDeckEmpty(side): boolean
```

### `js/battle/battle-state.js`

```js
export const INITIAL_MASTER_HP = 10
export const INITIAL_STONES = 0
export const INITIAL_HAND_SIZE = 5
export const MAX_HAND_SIZE = 7
export const STONES_PER_TURN = 3
export const MAX_STONES = 10

export function newBattleSide(deckCardIds): BattleSide
export async function initBattle(playerDeckIds, cpuDeckIds): Promise<Battle>
export function getBattle(): Battle | null
```

## 6. テスト計画

1. `data/cards/heroes.json` を node から JSON.parse して 3 件存在 + 各 `mchHeroId` が 1001/1002/1003
2. `node -e` で `js/battle/cards.js` を import して `loadCardDb()` 相当の fetch を simulate (= file:// なので test runner では fs.readFile で代替)
3. `shuffleDeck([1,2,3,...,10])` を 100 回回して seed なしで permutation 多様性を確認 (= Set 化で同一比率 5% 以下)
4. `drawCard()` で deck から hand に 1 枚移動、 deck.length が -1、 hand.length が +1
5. `initBattle(['mch_1001'], ['mch_1002'])` で `state.battle.player.deck.length === 1` / `state.battle.cpu.deck.length === 1` / `masterHp === 10` / `stones === 0`
6. ブラウザで `index.html` を開き、 console で `await window.__testBattle()` を実行して上記 simulate が `[ok]` を返す

## 7. PR 構成

- ブランチ: `claude/import-kickoff-document-bQ6rP` (= 継続)
- コミット 1: SPEC-102 docs + changelog fragment
- コミット 2: 実装 (`data/cards/heroes.json` + `js/battle/*.js` + `js/state.js` の `state.battle = null` 追加 + `js/main.js` の `window.__testBattle`)
- コミット 3: SPEC-INDEX / CHANGELOG 再生成

PR タイトル (= 同 PR 内継続): 必要に応じて update。

## 8. 関連 SPEC

- SPEC-100: 3 日計画 (= 上位、 Phase 1A は 「カード JSON + デッキ state」)
- SPEC-101: Phase 0 (= 前段、 prefix + Charter)
- SPEC-103: Phase 1B (= 次段、 ターンシステム + 召喚 + 攻撃)

## 9. スコープ縮約の注記

`SPEC-100` 2 章では Phase 1A に **「ヒーロー 3 体 + マジック 2 種」** と記載した
が、 マジックカードは MCH 経済圏に直接対応する概念がない (= `CLAUDE.md` MCH 経済圏
遵守の名称規約に従う場合、 MCH 既存のスキル / エクステンション 等から派生させる
必要があり、 設計議論が要る) ため、 **本 SPEC の実装からは外し**、 Day 2 以降の
SPEC で別途検討する。 ヒーローのみ 3 体でデッキとしては成立し、 Phase 1B の
ターンシステム検証は十分実施できる。
