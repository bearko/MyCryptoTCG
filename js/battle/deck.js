// ============================================================
// battle/deck.js — デッキ操作の純粋関数群
// ============================================================

/**
 * Fisher-Yates シャッフル (= in-place)
 * @param {string[]} deck - card id の配列
 * @returns {string[]} 同一配列 (= 副作用で並びが変わる)
 */
export function shuffleDeck(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/**
 * デッキの先頭から 1 枚引いて手札へ移動
 * デッキ切れの場合は null を返す (= 敗北判定の引き金は caller 側)
 * @param {{deck: string[], hand: string[]}} side
 * @returns {string | null} 引いたカード id、 デッキ切れなら null
 */
export function drawCard(side) {
  if (side.deck.length === 0) return null;
  const id = side.deck.shift();
  side.hand.push(id);
  return id;
}

/**
 * デッキの次に引かれるカードを read-only で peek
 * @param {{deck: string[]}} side
 * @returns {string | null}
 */
export function peekCard(side) {
  return side.deck.length === 0 ? null : side.deck[0];
}

/**
 * @param {{deck: string[]}} side
 * @returns {boolean}
 */
export function isDeckEmpty(side) {
  return side.deck.length === 0;
}
