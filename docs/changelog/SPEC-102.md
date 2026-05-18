**Added — カードデータ JSON + デッキ state + cards/deck モジュール (Day 1 Phase 1A)**

- `data/cards/heroes.json` 新規。 MCH master DB から先頭 3 体 (= heroId 1001 コナン・ドイル / 1002 甲斐姫 / 1003 張遼) を TCG カード定義として記載
  - 全カードに MCH 公式の `name` / `faction` / `rarity` / `mchHeroId` / `mchPassiveId` を引用 (= オリジナル名は付けない)
  - スキル名も MCH 公式 passive 名 (= シャーロック・ホームズ / 浪切 / 遼来遼来) を採用
  - `cost / hp / atk / row` は Day 1 デモバランス用に手動正規化 (= max level stats からゲームバランスに調整)
  - `portraitUrl` で MCH 公式 64×64 ポートレートを直接参照 (= スプライト未完成時の fallback も兼ねる)
- `js/battle/cards.js` 新規。 `loadCardDb()` で `data/cards/heroes.json` を fetch (= `data-loader.js` の cache 活用)、 `getHeroDef(cardDb, id)` で lookup
- `js/battle/deck.js` 新規。 純粋関数群 `shuffleDeck` (= Fisher-Yates in-place) / `drawCard` / `peekCard` / `isDeckEmpty`
- `js/battle/battle-state.js` 新規。 `INITIAL_MASTER_HP=10` / `STONES_PER_TURN=3` / `MAX_STONES=10` 等の定数 + `newBattleSide(deckCardIds)` / `initBattle()` / `getBattle()`
- `js/state.js`: `state.battle = null` を初期化フィールドとして追加 (= バトル外がデフォルト)
- `js/main.js`: `window.__testBattle()` を追加 (= console から手動 smoke test、 後続 SPEC のロジック層検証用)
- マジックカードは MCH 経済圏に直接対応する概念がないため Phase 1A から外し Day 2 以降で別途検討
- Phase 1B SPEC-103 (= ターンシステム / 召喚 / 攻撃) は本 SPEC の battle-state の上に乗る
