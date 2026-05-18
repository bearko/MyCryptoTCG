# Pattern 02 — 画面構成と z-index 階層

## 1. 画面の主構成

```
┌─────────────────────────────────────────┐
│ Title Screen (= titleView, z=1000)        │
│   Logo / Version Badge / Press to Start   │
│   Lang Toggle (= 下端)                    │
│   Ranking Button (= 任意)                 │
└─────────────────────────────────────────┘

  Press to Start → dismissTitle() →
  
┌─────────────────────────────────────────┐
│ Header (= factory-header)                 │
│   [β2 Badge] [Date] [Goal] ... [Gum] [✨] [Mai] [🏆] [Lang] [?]  │
├─────────────────────────────────────────┤
│ Stage (= factory-stage)                   │
│   ┌───────────────┬───────────────────┐  │
│   │ Workshop      │ Progress Cards    │  │
│   │ - heroes      │ - Craft  ◀ 1/3 ▶  │  │
│   │ - facility    │ - Quest  ◀ 1/3 ▶  │  │
│   │               │ - Market          │  │
│   └───────────────┴───────────────────┘  │
├─────────────────────────────────────────┤
│ Footer (= 権利表記 + version)             │
└─────────────────────────────────────────┘

  Modal は z=320+ で stage 全面を覆う
```

## 2. z-index 階層 (= 厳守)

| 層 | z-index | 用途 |
|---|---|---|
| 背景・マップ | 0-4 | workshop bg, facility |
| スプライト | 5-8 | hero sprite, card |
| 通常 UI | 10-90 | button, panel, hover focus |
| Floating popup | 100 | sprite float, notification |
| Modal 背景 | 120 | deck modal, settings |
| カットイン | 150 | event animation |
| Title | 200 | title screen |
| 緊急 popup | 320 | salary report, contest, marco-polo |
| Loading | 1000 | initial splash |
| Ranking | 1100+ | (= title より上に置きたい場合) |

派生プロジェクトでも基本この数値で。 **大きすぎる z-index は使わない** (= 1100 が上限の目安)。

## 3. Title Screen レイアウト

```html
<div id="titleView" class="title-screen" role="button" tabindex="0">
  <img class="title-logo" src="./Image/title-logo.jpg" alt="Game Title" />
  <div class="title-alpha-stack">
    <span class="alpha-badge" data-i18n="alpha.badge">β2 版 / BETA2</span>
    <p class="title-alpha-note" data-i18n="alpha.note">β2 版です…</p>
  </div>
  <p class="title-press" data-i18n="title.press">Press to Start</p>
  <div class="lang-toggle" id="langToggle">
    <span class="lang-toggle-label" data-i18n="lang.toggle.label">Language / 言語</span>
    <div class="lang-toggle-buttons">
      <button class="lang-btn" data-lang="ja">JP：日本語</button>
      <button class="lang-btn" data-lang="en">EN：English</button>
    </div>
  </div>
  <button class="title-ranking-btn" id="titleRankingBtn">🏆 ランキング</button>
  <p class="title-version">© author / unofficial fan project</p>
</div>
```

```css
.title-screen {
  position: fixed; inset: 0; z-index: 1000;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  background: #ffffff;       /* or your brand color */
  cursor: pointer; user-select: none;
  gap: 2.4rem;
}
.title-screen.hidden { display: none !important; }
.title-screen.title-out { animation: title-fade-out 0.38s ease forwards; }

@keyframes title-fade-out { to { opacity: 0; } }

.title-logo { max-width: min(420px, 88vw); border-radius: 12px; }

.alpha-badge {
  display: inline-block;
  padding: 0.28rem 0.85rem;
  background: linear-gradient(135deg, #c4a35a 0%, #e0c178 100%);
  color: #1a1420;
  border: 2px solid #1a1420;
  border-radius: 999px;
  font-weight: 800; font-size: 0.78rem;
  letter-spacing: 0.16em;
}

.title-version {
  position: fixed; bottom: 0.55rem; left: 50%;
  transform: translateX(-50%);
  font-size: 0.7rem; color: #6c5e8a;
  letter-spacing: 0.16em;
  pointer-events: none;
}
```

## 4. Header レイアウト

```html
<div class="factory-header">
  <span class="alpha-badge alpha-badge--header" data-i18n="alpha.badge">β2 版 / BETA2</span>
  <div class="factory-header__date">
    <span id="factoryDate">2018年 12月 1週</span>
  </div>
  <span class="factory-header__factory-lv" id="factoryLvText">工房Lv: 1</span>
  <div class="factory-header__spacer"></div>
  <button class="factory-header__btn factory-header__effects-btn hidden" id="headerActiveEffectsBtn">
    ✨ <span id="headerActiveEffectsCount">0</span>
  </button>
  <div class="factory-header__gum">
    <img class="factory-header__gum-icon" src="https://.../icon_gum.png" alt="GUM" />
    <span id="factoryGum">500</span>
  </div>
  <button class="factory-header__btn" id="headerRankingBtn" title="ランキング">🏆</button>
  <button class="factory-header__btn" id="btnLangToggle">JP</button>
  <button class="factory-header__btn" id="btnHelpOpen">?</button>
</div>
```

ボタンは右寄せで `--spacer` で押し出す。 タッチターゲットは 32px+ を確保。

## 5. Modal の標準レイアウト

```html
<div class="my-modal hidden" id="myModal" role="dialog" aria-modal="true">
  <div class="my-modal__card">
    <header class="my-modal__head">
      <h2 class="my-modal__title">タイトル</h2>
      <button class="my-modal__close-x" aria-label="Close">×</button>
    </header>
    <div class="my-modal__body"></div>
    <button class="my-modal__close" data-i18n="btn.close">閉じる</button>
  </div>
</div>
```

```css
.my-modal {
  position: fixed; inset: 0; z-index: 320;
  background: rgba(15, 12, 22, 0.92);
  display: flex; align-items: center; justify-content: center;
  padding: 1rem;
}
.my-modal.hidden { display: none !important; }
.my-modal__card {
  max-width: 520px; width: 100%; max-height: 90vh;
  background: linear-gradient(180deg, #2c2440 0%, var(--panel) 100%);
  border: 2px solid var(--accent);
  border-radius: 12px;
  padding: 1rem 1.1rem 0.9rem;
  display: flex; flex-direction: column; gap: 0.6rem;
  overflow-y: auto;
  box-shadow: 0 8px 30px rgba(0,0,0,0.7);
}
```

## 6. Modal 閉じる動作

3 つの方法で閉じられること:

```js
// 1. 「閉じる」 ボタン
$("#myModalClose").addEventListener("click", closeMyModal);

// 2. 背景クリック
$("#myModal").addEventListener("click", (e) => {
  if (e.target.id === "myModal") closeMyModal();
});

// 3. Esc キー
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#myModal").classList.contains("hidden")) {
    closeMyModal();
  }
});
```

## 7. Progress Card 階層 (= 並行スロット対応)

```html
<section class="progress-card" data-card-id="craft" style="position:relative;">
  <div class="order-pager hidden" id="craftPager">
    <button class="order-pager__btn" id="craftPagerPrev">◀</button>
    <span class="order-pager__label" id="craftPagerLabel">1 / 1</span>
    <button class="order-pager__btn" id="craftPagerNext">▶</button>
  </div>
  <h3 class="progress-card__title">Craft</h3>
  <div class="progress-card__body" id="craftCardBody"></div>
</section>
```

ページャは `position: absolute` で右上に貼る。 cap === 1 なら hidden。

## 8. Quest Overlay (= 工房上部の進捗バー)

ユーザー要望: 並行クエストでも **メイン 1 件 + 「他N件」 バッジ** で表示。 カードは増やさない。

```js
function renderQuestOverlay() {
  const activeQuests = [];
  forEachQuestSlot((idx, aq) => { if (aq) activeQuests.push({ idx, aq }); });
  if (activeQuests.length === 0) {
    host.classList.add("hidden"); return;
  }
  // viewIdx と一致する quest を main 表示
  const mainEntry = activeQuests.find(e => e.idx === viewIdx) || activeQuests[0];
  const otherCount = activeQuests.length - 1;
  const otherBadge = otherCount > 0
    ? `<span class="quest-overlay__other">他 ${otherCount} 件</span>`
    : "";
  host.innerHTML = `
    <div class="quest-overlay__node">${nodeName}${otherBadge}</div>
    ...
  `;
}
```
