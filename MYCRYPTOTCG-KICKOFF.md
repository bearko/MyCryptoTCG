# MyCryptoTCG — Kickoff 企画書 (= 新リポジトリ引き継ぎ用)

> このファイルは **`mycryptotemplate` の `claude/create-mycryptotcg-game-F2ueH` ブランチ**
> で書かれた、 派生プロジェクト `mycryptotcg` 着手のためのハンドオフ文書です。
> 新リポジトリ (`bearko/mycryptotcg`) を作成した後、 このファイル冒頭の手順に従って
> 必要な情報を新リポジトリに移植してから、 通常の SPEC 駆動開発に入ります。
>
> **このファイルそのものは `mycryptotemplate` の main にはマージしません** (= テンプレートを汚染しないため)。

---

## 0. 着手手順 (= 1 度きり)

### Step 0-1. 新リポジトリ作成 (= GitHub UI)

1. https://github.com/bearko/mycryptotemplate を開く
2. 右上の緑ボタン **Use this template → Create a new repository**
3. Owner = `bearko` / Repository name = **`mycryptotcg`** / **Public**
4. **Include all branches: OFF** (= main だけコピー、 本ブランチは引き継ぎ不要)
5. **Create repository** をクリック

(= 「Use this template」 ボタンが表示されない場合は、 mycryptotemplate の
**Settings → General → Template repository** にチェックを入れる)

### Step 0-2. ローカルクローン

```bash
git clone https://github.com/bearko/mycryptotcg
cd mycryptotcg
```

### Step 0-3. 本ファイルを新リポジトリへ移植

```bash
# このブランチ (mycryptotemplate の claude/create-mycryptotcg-game-F2ueH) から
# MYCRYPTOTCG-KICKOFF.md だけを新リポジトリ root にコピー
curl -L -o MYCRYPTOTCG-KICKOFF.md \
  https://raw.githubusercontent.com/bearko/mycryptotemplate/claude/create-mycryptotcg-game-F2ueH/MYCRYPTOTCG-KICKOFF.md
git add MYCRYPTOTCG-KICKOFF.md
git commit -m "chore: import kickoff document from template branch"
```

### Step 0-4. 新セッションで Day 1 Kickoff プロンプト投下

新リポジトリ (`bearko/mycryptotcg`) で Claude Code 新セッションを開き、
**本ファイルの 9 章 「Day 1 Kickoff プロンプト (= MCT 用に完成版)」** をコピペで投下。

Claude は CLAUDE.md → AGENTS.md → docs/charters → docs/patterns の順に読み、
**SPEC-001 (= プロジェクト Charter) と Day 1 モック PR** を 1 セッションで完成させます。

---

## 1. プロジェクト基本情報

| 項目 | 値 |
|---|---|
| プロジェクト名 | **MyCryptoTCG** |
| 略称 / リポジトリ名 | `mycryptotcg` |
| タグライン | MCH ヒーローで戦う、 64x64 ピクセルアニメ × 高速カードバトル |
| ジャンル | TCG (= トレーディングカードバトル) |
| 参考タイトル | **任天堂 「高速カードバトル カードヒーロー」 (DS, 2007)** をコアルールベース、 MCH の世界観と装備拡張を上乗せ |
| コアゲームループ | (1) MCH ヒーローを召喚 (2) ストーンでとくぎ発動 (3) 相手マスター HP を 0 にする |
| 対象プラットフォーム | PC + Mobile (= モバイル portrait 重視) |
| 対応言語 | ja / en (= i18n 基盤あり) |
| ビジュアルトーン | **64×64 ピクセルアート + シネマティックなエフェクト**、 戦闘演出は MCH のカラーパレット (= 黒地 + 強調色) |
| localStorage prefix | **`mctcg`** (= MyCrypto TCG 5 文字、 mct / mcf / mcs と被らない) |
| ASSET_BASE | `https://raw.githubusercontent.com/bearko/mycryptotcg/main/assets/` (= 64×64 スプライトを本リポに置く前提。 静止画は MCH 公式 CDN を併用) |

---

## 2. カードヒーロー (= 任天堂) ルール — 採用版仕様

> WebFetch がネットワーク allowlist で 403 だったため、 公式 rule ページの直接取得は
> 不可。 Wikipedia 要約 (= WebSearch 経由)、 個人解説サイト複数を突き合わせた結果です。
> 実機検証は新リポでの SPEC-002 着手時に必要に応じて追加調査。

### 2-1. 採用 = **DS 高速版ベース + MCH 拡張 (= 4 章のハイブリッド方針)**

| 要素 | DS 高速版仕様 | 採用判断 |
|---|---|---|
| フィールド | 自陣 / 敵陣それぞれマスター 1 + モンスター 4 (= 2x2) | 採用、 ただし MVP は前衛 1 + 後衛 1 の **計 2 体** に縮約 (= スピードバトル準拠) |
| マスター HP | ストーン数で表現、 被弾で手持ちに移動 | 採用 (= 初期 HP = 10 ストーン) |
| ストーン補充 | 毎ターン 3 個 | 採用 |
| モンスター召喚 | 配置 → 1 ターン後に登場 (= 召喚酔い) | 採用 (= 視覚的にも「召喚エフェクト → 待機 → 始動」の流れで気持ちよい) |
| アクション | 召喚 / 攻撃 / レベルアップ / マジック / 終了 | 採用 |
| 相手ターン | 基本介入不可 (= 高速 = テンポ良い) | 採用 (= mobile UX に最適) |
| カード種別 | モンスター / マジック / アイテム | 採用 |
| レベルアップ | 倒した敵のレベル分だけ自分が上がれる (ストーン消費) | 採用 (= Phase 2 で実装、 Day 1 では Lv1 固定) |
| 勝利条件 | マスター HP 0 / または相手のデッキ切れ | 採用 |

### 2-2. ターン構造 (= 採用版)

```
自ターン開始
  1. ドロー (= デッキから 1 枚、 デッキ切れなら敗北)
  2. ストーン補充 (= +3、 上限 10)
  3. アクションフェーズ (= 以下を任意回数、 ストーンと手札の許す限り)
     - モンスター召喚 (= コスト消費、 召喚酔い)
     - とくぎ使用 (= モンスター or マスター)
     - 攻撃 (= 召喚酔いでないモンスター → 相手前衛 → 後衛 → マスター)
     - マジック使用 (= ストーン消費)
     - レベルアップ (= 倒した敵のレベル分まで、 ストーンを払い、 攻撃力+とくぎ追加)
     - エクステンション装備 (= MCH 拡張、 Phase 2)
  4. 終了宣言
相手ターン (= 同じ流れ、 介入不可)
```

### 2-3. カード仕様 (= データ構造案)

```json
// data/cards/monsters.json (例)
{
  "id": "mch_001",
  "type": "monster",
  "name": { "ja": "ノア", "en": "Noah" },  // MCH 公式ヒーロー名そのまま (= CLAUDE.md MCH 経済圏遵守)
  "mchHeroId": 1,                          // mycryptoheroes リポへの参照
  "cost": 3,                               // 召喚コスト (= ストーン)
  "hp": 4,
  "atk": 2,
  "skills": [                              // とくぎ (= MCH スキル名を使う)
    { "id": "fire_ball", "cost": 2, "effect": "damage:2" }
  ],
  "sprite": "noah",                         // assets/sprites/heroes/noah.* のキー
  "row": "front"                            // front (前衛) / back (後衛) どちらに置けるか
}
```

```json
// data/cards/magics.json (例)
{
  "id": "mag_heal_01",
  "type": "magic",
  "name": { "ja": "回復の祈り", "en": "Heal Prayer" },
  "cost": 2,
  "effect": "heal_master:3"
}
```

```json
// data/cards/extensions.json (例 — Phase 2)
{
  "id": "ext_001",
  "type": "extension",
  "name": "Excalibur",                     // MCH エクステンション名を使う
  "mchExtId": 1,
  "cost": 2,
  "effect": "atk+2;skill+fireball"
}
```

### 2-4. 勝利条件 (= 採用)

- 相手マスター HP (= ストーン) を 0 に
- または相手のデッキ切れ (= 相手がドローできない)

---

## 3. MCH 経済圏の統合方針

`CLAUDE.md` 「MCH 経済圏の遵守」 に厳格に従う。

### 3-1. 概念マッピング

| TCG 概念 | MCH 概念 | 呼称 (= 必ずこれを使う) |
|---|---|---|
| クリーチャー / モンスター | MCH ヒーロー | **ヒーロー** (= UI 表示も「ヒーロー」、 「モンスター」は CPU 専用語) |
| 装備カード | MCH エクステンション | **エクステンション** |
| とくぎ | MCH スキル | **スキル** (= UI で「スキル」、 内部変数は `skill` ですが、 ゲーム内表記は MCH 公式呼称) |
| マナ / ストーン | (TCG 独自) | **ストーン** (= GUM とは別物、 戦闘リソース。 戦闘外通貨は GUM) |
| 戦闘外通貨 | GUM | **GUM** (= パック購入 / カード強化に使用) |
| 経験値 | CE | **CE** (= ヒーロー強化用) |
| 敵 CPU 単位 | エネミー | **エネミー** (= 主に PvE モードの敵キャラ、 PvP では「対戦相手」) |

### 3-2. データソース

- マスター DB: https://github.com/bearko/mycryptoheroes
  - ヒーローパラメータ (= HP / ATK / スキル) を取得
  - エクステンション (= 装備) を参照
  - スキル名・効果を MCH 公式から引用
- `js/constants.js` の `ASSET_BASE` を本リポジトリの `assets/` に向け、
  ヒーロースプライト (= 64×64 自作) はここに格納
- 静止アイコン (= GUM / CE / UI 飾り) は MCH 公式 CDN を併用 (= `js/constants.js` で URL 解決)

### 3-3. オリジナル禁止事項

- 架空のヒーロー名 (= 「炎の戦士」 のような MCH 風名称) を Claude が作るのは禁止
- スキル名も MCH に存在するものを使う (= 「火球の術」 のような独自命名は禁止)
- 新ヒーロー追加は SPEC で合意してから (= MCH 設定との整合確認)

---

## 4. アニメーション パイプライン (= 最こだわりポイント)

採用 = **Sprite Sheet + CSS `steps()` (= バニラ JS)** by ユーザー選択。
依存ゼロでビルドステップ不要、 テンプレートの設計指針と完全に整合。

### 4-1. スプライト規格

| 項目 | 値 |
|---|---|
| **1 フレーム解像度** | 64×64 px (= ピクセルアート前提) |
| **シート構成** | 横並び (= horizontal strip) |
| **アクション種別** | `idle` / `attack` / `hit` / `cast` / `die` (= 最低限) |
| **フレーム数 / アクション** | 4〜8 (= 標準 6、 idle のみ 2 でもよい) |
| **書き出し形式** | PNG (= 透過、 image-rendering: pixelated 前提) |
| **ファイル命名** | `<heroId>_<action>.png` 例 `noah_idle.png`, `noah_attack.png` |
| **配置** | `assets/sprites/heroes/<heroId>/<action>.png` |
| **メタデータ** | Aseprite → JSON export で `assets/sprites/heroes/<heroId>/<action>.json` (= フレーム数 / duration を JS に伝える) |

### 4-2. 制作ツール (= 候補)

1. **Aseprite** (= 推奨、 \$19.99 買い切り)
   - レイヤー / タグ / オニオンスキン / プレビュー が pixel art 専用に最適化
   - CLI で `aseprite --batch hero.ase --tag "attack" --sheet attack.png --data attack.json` でバッチ書き出し可
   - JSON メタデータが `{ frames: { "0": { duration: 80, frame: {x,y,w,h} } } }` 形式で出る
2. **Sprite-AI / Pixellab / Sprite Fusion** (= AI 補助)
   - 1 枚絵 → 自動でアニメーション補完するサービス
   - MCH 公式画像を入力 → 64×64 6 フレーム生成 → Aseprite で微修正のフロー
   - 量産には便利、 ただし AI 出力は品質ばらつきあるので 主要 10 体は手描き仕上げ推奨
3. **手作業のみ** (= Aseprite 単独)
   - 主要ヒーロー 5〜10 体だけ高品質、 残りは Phase 2 以降の課題に

### 4-3. JS / CSS 実装 (= テンプレートに追加するパターン)

`css/components.css` に sprite 基底クラスを追加:

```css
.sprite {
  width: 64px;
  height: 64px;
  background-repeat: no-repeat;
  background-position: 0 0;
  image-rendering: pixelated;        /* Chrome / Safari */
  image-rendering: crisp-edges;       /* Firefox */
  transform-origin: center;
}

/* idle (= 2 フレーム、 1.0s) */
.sprite.is-idle {
  background-image: var(--sprite-idle);
  animation: sprite-idle 1.0s steps(2) infinite;
}
@keyframes sprite-idle {
  from { background-position: 0 0; }
  to   { background-position: -128px 0; }   /* 64 * 2 = 128 */
}

/* attack (= 6 フレーム、 0.48s、 1 回再生で onanimationend → idle に戻す) */
.sprite.is-attack {
  background-image: var(--sprite-attack);
  animation: sprite-attack 0.48s steps(6) 1;
}
@keyframes sprite-attack {
  from { background-position: 0 0; }
  to   { background-position: -384px 0; }   /* 64 * 6 = 384 */
}

/* hit (= 4 フレーム、 0.32s) */
.sprite.is-hit {
  background-image: var(--sprite-hit);
  animation: sprite-hit 0.32s steps(4) 1;
}
@keyframes sprite-hit {
  from { background-position: 0 0; }
  to   { background-position: -256px 0; }
}
```

`js/battle/sprite.js` (= 新規) で state machine:

```js
import { img } from "../constants.js";

export function attachSprite(el, heroId) {
  el.classList.add("sprite", "is-idle");
  el.style.setProperty("--sprite-idle", `url("${img(`sprites/heroes/${heroId}/idle.png`)}")`);
  el.style.setProperty("--sprite-attack", `url("${img(`sprites/heroes/${heroId}/attack.png`)}")`);
  el.style.setProperty("--sprite-hit", `url("${img(`sprites/heroes/${heroId}/hit.png`)}")`);
}

export function triggerAttackAnim(el) {
  el.classList.remove("is-idle");
  el.classList.add("is-attack");
  el.addEventListener("animationend", function onEnd() {
    el.classList.remove("is-attack");
    el.classList.add("is-idle");
    el.removeEventListener("animationend", onEnd);
  }, { once: true });
}

export function triggerHitAnim(el) {
  // is-idle と並行で is-hit を一時的に重ねる (= 2 layer trick or filter)
  el.classList.add("is-hit");
  setTimeout(() => el.classList.remove("is-hit"), 320);
}
```

### 4-4. 戦闘演出パターン (= 推奨)

| 場面 | 演出 |
|---|---|
| 召喚 | プレイヤー位置に光るエフェクト (= confetti or sprite float) + 1 ターン待機の「召喚酔い」 で半透明 idle |
| 通常攻撃 | アタッカー idle → attack 1 回 → 攻撃エフェクト (= 斬撃線) → 被ダメージ側 hit + ダメージ数値 float |
| スキル発動 | アタッカー前に cast (= 詠唱、 0.5s) → スキルアイコン拡大 → 効果適用 |
| マスター被弾 | マスター枠が振動 (= CSS keyframes shake) + ストーンが手持ちに移動 (= 数値減少のアニメ) |
| 撃破 | 対象 die (= 4 フレーム fade out) → カードが手札 / 場から消える |

### 4-5. パフォーマンス考慮

- 同時にアニメーション中のスプライトは最大 10 体程度 (= 1v1 で前後衛各 2 体 + マスター 2 + エフェクト)
- CSS animation は GPU 加速されるので 60fps 余裕
- スプライト PNG は **WebP 化を Phase 2 検討** (= ファイルサイズ削減)
- preload (= `<link rel="preload" as="image">`) を `index.html` の起動時に主要 idle だけ実施

---

## 5. Day 1 MVP スコープ (= ユーザー選択 「1 バトルデモ」)

### 5-1. 達成基準

- [ ] タイトル画面表示 (= 「MyCryptoTCG」 ロゴ + Press to Start)
- [ ] Press → デモバトル開始
- [ ] 固定デッキ (= MCH ヒーロー 5 体 + マジック 2 種 + ストーン 10 初期) vs 固定 CPU デッキ
- [ ] ターン進行: ドロー → 補充 → 手札タップで召喚 → 攻撃ボタン → 終了
- [ ] ヒーロー 1 体以上に **idle + attack + hit** スプライトアニメーションが動く
- [ ] 勝利 / 敗北画面 → タイトルに戻る
- [ ] PC (1280×800) + Mobile (375×667) 両方で破綻しない
- [ ] JP / EN 切替が動く

### 5-2. 非ゴール (= Day 1 では作らない)

- レベルアップ機能 (= Lv1 固定)
- エクステンション装備 (= Phase 2)
- パック開封 / コレクション (= Phase 3)
- ランキング送信 (= スタブだけ、 SPEC-002 で実装)
- セーブ / ロード (= Phase 2)
- 複数バトル選択 (= 固定 1 戦のみ)

### 5-3. アセット (= Day 1 最低限)

- **スプライト**: 主要ヒーロー **3 体だけ** (= idle + attack + hit、 残りはプレースホルダ静止画 + 振動アニメ)
- **マスター**: プレイヤー / CPU 共に 1 体ずつ静止画 + 振動アニメ
- **エフェクト**: 既存 `effects.js` の confetti + sprite float を流用、 斬撃線だけ新規

### 5-4. Phase 構造

| Phase | 対象 | 内容 |
|---|---|---|
| Phase 0 | SPEC-001 | プロジェクト Charter / リネーム / prefix 置換 (= `mctcg`) |
| Phase 1A | SPEC-002 | カードデータ JSON + デッキ管理 state |
| Phase 1B | SPEC-003 | ターンシステム + 召喚 + 攻撃 (= ロジック層) |
| Phase 1C | SPEC-004 | UI 配置 (= バトル画面、 手札、 場、 マスター枠) |
| Phase 1D | SPEC-005 | アニメーション (= sprite sheet, idle/attack/hit) |
| Phase 1E | SPEC-006 | CPU AI (= ルールベース、 最善手は使わない) |
| Phase 1F | SPEC-007 | 勝利 / 敗北画面 + タイトル復帰 |

Day 1 PR は Phase 1A〜1F のうち **最小実装** を 1 つの大 PR ではなく、
**Phase 1A だけ動くデモ** として最初の Draft PR にする (= 残りは別 SPEC で順次)。

---

## 6. 次フェーズ SPEC 骨子 (= ロードマップ)

| SPEC | タイトル | 目的 |
|---|---|---|
| SPEC-001 | プロジェクト Charter (Bootstrap) | Charter 記述 + prefix 置換 + i18n 初期化 |
| SPEC-002 | カードデータと state | カード JSON 設計 + デッキシャッフル + 手札管理 |
| SPEC-003 | ターンシステムとアクション | ドロー / 補充 / 召喚 / 攻撃のロジック |
| SPEC-004 | バトル画面 UI | DOM 配置 + タップで召喚 / 攻撃の操作系 |
| SPEC-005 | スプライトアニメーション | idle / attack / hit + 状態遷移 + 演出 |
| SPEC-006 | CPU AI (= 弱め) | ルールベースの相手 |
| SPEC-007 | 勝敗判定と画面遷移 | win/lose 画面 + タイトル復帰 |
| SPEC-008 | レベルアップ仕様 | カードヒーロー本家のレベル消費メカニクス |
| SPEC-009 | エクステンション装備 | MCH エクステンションの戦闘内効果 |
| SPEC-010 | デッキビルダー | カード一覧 + デッキ編成 UI |
| SPEC-011 | パック開封 | GUM でパック購入 → カード入手 |
| SPEC-012 | コレクション画面 | 所持カード一覧 + ソート / フィルタ |
| SPEC-013 | ランキング (= Backend B) | スコア送信 + 上位 100 表示 (= `RANKING_SETUP.md` の Backend B 既定に従う) |
| SPEC-014 | スプライト量産パイプライン | Aseprite テンプレ + AI 補助フロー定着 |

---

## 7. 技術選択メモ (= 不変点 + 新規選択)

### 7-1. 不変 (= テンプレート規約)

- プレーン ES Modules + バニラ JS、 TypeScript / バンドラ なし
- 静的 hosting (= Vercel) で `build:` 不要
- データは `data/*.json` から runtime fetch
- `js/constants.js` の `ASSET_BASE` 経由ですべての URL 解決

### 7-2. MyCryptoTCG 固有の決定

- localStorage prefix: **`mctcg`** (= 既存の mct/mcf/mcs と衝突しない 5 文字)
- ASSET_BASE: `https://raw.githubusercontent.com/bearko/mycryptotcg/main/assets/`
- スプライトディレクトリ: `assets/sprites/heroes/<heroId>/<action>.png`
- アニメーション: CSS `steps()` + `image-rendering: pixelated`
- ランキング: **Backend B (= Upstash + Vercel)** 既定 (= CLAUDE.md 推奨に従う、 SPEC-013 で実装)
- 開発言語: ja / en の 2 言語
- 戦闘描画ターゲット: 60fps 安定、 同時アニメ最大 10 体

### 7-3. CDN 依存 (= ゼロビルドの代償として許容)

- なし (= スプライトは自リポ assets、 アイコンは MCH 公式 CDN を併用)
- PixiJS 等の WebGL 系は **採用しない** (= 4-2 のユーザー選択により)

---

## 8. 着手前チェックリスト

新リポジトリで作業を始める前に、 以下を確認:

- [ ] `bearko/mycryptotcg` が GitHub に作成済み
- [ ] ローカルクローン完了
- [ ] このファイル (`MYCRYPTOTCG-KICKOFF.md`) が新リポ root にコピーされた
- [ ] Vercel に新リポを link した (= 自動 deploy 用、 任意だが推奨)
- [ ] Upstash Redis インスタンスを Vercel project の Storage タブから作成 (= SPEC-013 で必要、 後でも可)
- [ ] Aseprite の購入 / インストール 完了 (= スプライト制作で必須)
- [ ] MCH 公式 repo (`bearko/mycryptoheroes`) のヒーロー DB / エクステンション DB の場所を把握

---

## 9. Day 1 Kickoff プロンプト (= MCT 用に完成版)

> 以下をそのままコピーして、 **新リポジトリ `bearko/mycryptotcg`** で開いた
> Claude Code 新セッションに投下してください。 `<FILL: ...>` は全て埋めた状態です。

````markdown
# Day 1 Project Kickoff — MyCryptoTCG

私は `mycryptotemplate` をベースに新規ゲームプロジェクト `MyCryptoTCG` を立ち上げます。
あなたは私のペアプロパートナーとして、 以下の手順で **Day 1 のモック** を構築してください。

---

## ⚠ 最重要 — 着手前に必ず読むこと

以下のドキュメントを **この順序で** 読み、 それに従って作業してください。
まだ読んでいない状態で実装を始めないでください。

1. `MYCRYPTOTCG-KICKOFF.md` (= 本プロジェクトの企画書、 最優先で読む)
2. `README.md`
3. `CLAUDE.md` (= 命名規則・規約・必読リスト、 特に 「MCH 経済圏の遵守」)
4. `AGENTS.md`
5. `docs/charters/PROJECT_CHARTER.md` (= MYCRYPTOTCG-KICKOFF の内容で書き換える)
6. `docs/charters/DEVELOPMENT_CHARTER.md`
7. `docs/charters/DESIGN_CHARTER.md`
8. `docs/patterns/01-environment-and-assets.md`
9. `docs/patterns/02-screen-structure.md`
10. `docs/patterns/03-i18n-and-help.md`
11. `docs/patterns/04-time-and-modals.md` (= pauseFlags 必読)
12. `docs/process/SPEC_DRIVEN_DEVELOPMENT.md`

**複数ファイルの読み込みは `Explore` sub-agent に依頼**(= context 節約)。

---

## 1. プロジェクト基本情報 (= MYCRYPTOTCG-KICKOFF.md 1 章参照)

- **プロジェクト名**: MyCryptoTCG
- **タグライン**: MCH ヒーローで戦う、 64×64 ピクセルアニメ × 高速カードバトル
- **ジャンル**: TCG (= 高速カードバトル ベース)
- **参考タイトル**: 任天堂 「高速カードバトル カードヒーロー」 (DS, 2007) + MCH 経済圏拡張
- **コアゲームループ**:
  1. プレイヤーは手札の MCH ヒーローを召喚し場に配置する
  2. ストーンを使ってとくぎを発動し、 相手モンスター / マスターを攻撃する
  3. 相手マスターの HP (= ストーン) を 0 にすれば勝利
- **対象プラットフォーム**: PC + Mobile
- **対応言語**: JP + EN
- **ビジュアルトーン**: 64×64 ピクセルアート + シネマティック演出、 MCH カラーパレット

## 2. 機能スコープ (= MYCRYPTOTCG-KICKOFF.md 5 章参照)

### 必須機能 (= MVP)
- カードバトル (= 1v1 デモ、 固定デッキ vs CPU、 ターン制)
- スプライトアニメーション (= idle / attack / hit、 主要 3 体で先行実装)
- カード召喚 → 攻撃 → 勝敗判定の最小ループ
- MCH ヒーロー / エクステンション / スキル名の正式採用 (= オリジナル名禁止)
- JP / EN 切替

### 仕組み採否
- 時間進行 (= ホーム画面で待機中のみ tick): **NO** (= バトル中心、 時間進行は非採用)
- ランキング: **YES (default backend = Upstash + Vercel)** (= SPEC-013 で実装、 Day 1 は UI スタブのみ)
- 多言語切替: **JP+EN**
- セーブ / ロード: **後で** (= Phase 2)
- 月次イベント: **NO**
- 並列スロット: **NO**

### 非ゴール (= MVP では作らない)
- レベルアップ (= Lv1 固定で開始、 SPEC-008 で実装)
- エクステンション装備 (= SPEC-009)
- パック開封 / コレクション (= SPEC-011, SPEC-012)
- セーブ / ロード (= Phase 2)

## 3. 技術設定

- **localStorage prefix**: `mctcg`
- **アセットCDN**: `https://raw.githubusercontent.com/bearko/mycryptotcg/main/assets/` (= 自リポ assets/)
- **GitHub リポジトリ**: `bearko/mycryptotcg`
- **ローカル作業パス**: (ユーザーのローカル環境による)

## 4. ターゲット体験 (= プレイヤーが最初の 60 秒で得る感覚)

タイトルに「MyCryptoTCG」ロゴ表示 → Press to Start → 説明モーダル (= 「ストーンを使ってヒーローを召喚、 相手マスターを倒せ」) → デモバトル開始 → 手札タップで MCH ヒーローを召喚 → 召喚エフェクト + idle アニメ → 攻撃ボタンで attack アニメ → 相手に hit アニメ + ダメージ数値 → 数ターン後に勝利画面 → タイトルに戻る。

---

## 5. Day 1 の到達点

- [ ] `index.html` をブラウザで開いて Console エラーなく表示
- [ ] Splash → Title → BattleDemo 画面 の遷移
- [ ] JP/EN 切替が動く
- [ ] ヘッダー + ヘルプボタン
- [ ] モーダル (= 戦闘説明 or 勝利画面) を pause/resume パターン通りに開閉
- [ ] **デモバトル** が動く (= 固定デッキ、 5 ターン以内で決着できる難易度)
- [ ] **主要ヒーロー 3 体に idle + attack + hit スプライト** が当てられている (= プレースホルダ画像で可、 重要なのはパイプラインが動いていること)
- [ ] PC (1280×800) + Mobile (375×667) 両方で破綻しない
- [ ] `docs/specs/SPEC-001-project-setup.md` 作成、 ステータス Done

## 6. 進め方

1. **必読ドキュメントを読む** (= 上記順序、 `Explore` agent 推奨)
2. **AskUserQuestion で曖昧な点を確認**
3. **`<prefix>` を `mctcg` に一括置換** (= js/constants.js + 各 SPEC + 文書)
4. **`docs/charters/PROJECT_CHARTER.md` を MYCRYPTOTCG-KICKOFF.md の内容で更新**
5. **`docs/specs/SPEC-001-project-setup.md` を作成** (= テストケース付き)
6. **Phase 1 PR**: タイトル + i18n + デモバトル骨組み を `feat/spec-001-phase-1-bootstrap` ブランチで Draft PR 化
7. **次の SPEC-002 (= カードデータと state) の骨子だけ提示**

## 7. 守ってほしい事項 (= 規約)

- `CLAUDE.md` の MCH 経済圏遵守 (= 名称統一、 オリジナル名禁止)
- `CLAUDE.md` の命名規則 (動詞 prefix: trigger/open/close/render/pick/apply/find/get/set/tick/is)
- `pauseFlags` パターン厳守 (= `docs/patterns/04-time-and-modals.md`)
- 1 PR = 1 論理変更、 Phase 分割
- main / prod に直 push 禁止、 必ず feature ブランチ + PR
- `console.log` / TODO 残しは commit 前に削除
- `ASSET_BASE` / `img()` / `audioUrl()` を `js/constants.js` に集約
- 画像 / 音声のフォールバック必須
- Conventional Commits + Phase tag + `Co-Authored-By: Claude ...`
- **絵文字を出力に含めない** (= UI / ドキュメント / コミットメッセージ / Claude の応答)

## 8. 質問してほしいタイミング (= 推測しないで)

以下のいずれかなら **必ず AskUserQuestion で確認**:

- スプライト未制作のヒーローの扱い (= プレースホルダ静止画 + 振動 で良いか / 制作してから着手か)
- カード効果 (= スキル) の MCH 公式参照先 (= URL 確認)
- CPU AI の難易度 (= MVP は弱めでよいか)
- UI のアートディレクション (= 「カードヒーロー DS 風」 vs 「MCH 公式の黒地カラーパレット 強め」)
- ランキング送信タイミング (= 勝利時のみ送信、 で良いか)

## 9. context 節約のお願い

- ファイル全文 Read は避ける、 `offset/limit` で部分読み
- 5 ファイル以上の探索は **Explore agent**
- 設計を固める段階では **Plan agent** を一回呼ぶ
- 大量ログは Grep の `head_limit` で絞ってから読む

## 10. 成果物 (= 1 セッション完了時に揃っているべきもの)

- [ ] `MYCRYPTOTCG-KICKOFF.md` が新リポに存在し、 内容が反映されている
- [ ] `PROJECT_CHARTER.md` 埋まっている
- [ ] `specs/SPEC-001-project-setup.md` ステータス Done
- [ ] Phase 1 PR が Draft で上がっている
- [ ] 次の `SPEC-002-card-data-and-state.md` の見出しと骨子だけ提示
- [ ] Vercel preview URL を私が手動で確認できる状態

それでは、 **まず `MYCRYPTOTCG-KICKOFF.md` と必読ドキュメントを `Explore` で読んで、 その後に基本情報の認識合わせの質問** から始めてください。
````

---

## 10. 参考情報源

WebFetch がネットワーク allowlist で 403 だったため、 公式ページ直取得は不可。
以下は WebSearch 結果から得た情報源で、 別環境で参照する際の URL:

### カードヒーロー (= 任天堂)

- [トレード&バトル カードヒーロー — Wikipedia](https://ja.wikipedia.org/wiki/%E3%83%88%E3%83%AC%E3%83%BC%E3%83%89&%E3%83%90%E3%83%88%E3%83%AB_%E3%82%AB%E3%83%BC%E3%83%89%E3%83%92%E3%83%BC%E3%83%AD%E3%83%BC)
- [高速カードバトル カードヒーロー — Wikipedia](https://ja.wikipedia.org/wiki/%E9%AB%98%E9%80%9F%E3%82%AB%E3%83%BC%E3%83%89%E3%83%90%E3%83%88%E3%83%AB_%E3%82%AB%E3%83%BC%E3%83%89%E3%83%92%E3%83%BC%E3%83%AD%E3%83%BC)
- [カードヒーロー部.com (= DS 版攻略 wiki)](https://www.cardhero-bu.com/)
- [カードヒーローまとめ wiki](http://cardherowiki.reela.net/)
- [高速カードバトル カードヒーロー — 任天堂公式](https://www.nintendo.co.jp/ds/ychj/index.html)
- [カードヒーロー：ストーリーでの基本ルール説明等 (= 個人解説)](https://tharja-neftyscyther.hatenadiary.jp/entry/2020/02/25/040000)

### ピクセルアートアニメーション

- [Aseprite — Sprite-sheet Docs](https://www.aseprite.org/docs/sprite-sheet/)
- [Aseprite — Exporting Docs](https://www.aseprite.org/docs/exporting/)
- [Pixel art Character Animations guide — Sandro Maglione](https://www.sandromaglione.com/articles/pixel-art-character-animations-guide)
- [Sprite animation frames — how many do you actually need?](https://www.sprite-ai.art/blog/sprite-animation-frames)
- [I challenged myself to animate a sprite sheet using only JS and CSS — Medium](https://medium.com/@westonvincze/i-challenged-myself-to-animate-a-sprite-sheet-using-only-js-and-css-3460d30cc818)
- [Animating Sprites with CSS and React — Alec Horner](https://alechorner.com/blog/animating-pixel-sprites-with-css)
- [How to animate pixel art sprites — Sprite-AI](https://www.sprite-ai.art/guides/how-to-animate-pixel-art)

### MCH 経済圏

- [bearko/mycryptoheroes — マスター DB](https://github.com/bearko/mycryptoheroes)
- [bearko/mycryptotemplate — テンプレート](https://github.com/bearko/mycryptotemplate)

---

(= このファイルは `mycryptotemplate` の `claude/create-mycryptotcg-game-F2ueH` ブランチで生成。 新リポジトリ移行後は本ブランチ削除可)
