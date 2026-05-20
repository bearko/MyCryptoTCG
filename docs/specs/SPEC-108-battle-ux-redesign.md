---
id: SPEC-108
title: バトル UX 再設計 (= 盤面 / 指示エリア / 手札フッター 3 ゾーン + 2 タップ確定式) (Phase 2)
status: Implementing
pr: claude/battle-ux-redesign
phase: Phase 2A
kind: Changed
---

# SPEC-108 — バトル UX 再設計

## 1. 目的

Day 2/3 で実装した battle screen は **portrait カードを field-slot として中央
配置 + 手札を下部に表示** する 1 列レイアウトだった。 これだと:

- どのユニットが行動主か / 対象かが視覚的に混乱しやすい
- 攻撃の範囲 / 影響 (= HP 変化) が事前に分からない
- master へのアクセスが暗黙的 (= 「空き slot を狙う」)

本 SPEC で UI を **3 ゾーン構成** に再設計し、 「誰が」 → 「何を」 → 「誰に」 の
動詞型操作フローを実現する。 ユーザー仕様 (= 直接のリクエスト) に従う。

## 2. レイアウト構成

```
┌────────────────────────────────────────┐
│ Header (= 既存、 lang / help)            │
├────────────────────────────────────────┤
│                                          │
│   Board area (= 上半分)                  │
│   - ターン / phase                         │
│   - 選択中の actor / target 詳細パネル    │
│   - スキル選択時: 範囲プレビュー           │
│   - 対象選択時: HP before/after           │
│   - 勝敗 / hint                            │
│                                          │
├────────────────────────────────────────┤
│   Instruction area (= 下半分)            │
│   ┌─ 敵ゾーン ──────────────────────┐  │
│   │ [back] [front] [master]           │  │
│   └────────────────────────────────┘  │
│   ┌─ 味方ゾーン ─────────────────────┐  │
│   │ [back] [front] [master]           │  │
│   └────────────────────────────────┘  │
│   Skill chooser (= ally 選択時のみ)    │
│   [通常攻撃] [skill1] [skill2] ...     │
├────────────────────────────────────────┤
│ Footer:                                 │
│ Hand: [card1] [card2] ... [End Turn]   │
└────────────────────────────────────────┘
```

各 instr-slot は **アイコン + 枠線つきカード** (= ユーザー仕様)。 ヒーローには
portrait + HP / ATK / status、 master には専用アイコン + HP / stones。

## 3. インタラクション仕様 (= ユーザー仕様の明文化)

### 3-1. 動詞型操作フロー

```
[誰が]    actor 選択      → ally hero/master タップ
[何を]    skill 選択      → skill chooser でタップ
[誰に]    target 選択 1st → 対象 instr-slot タップ → board に preview
[実行]    target 選択 2nd → 同じ対象を再タップ → 即実行
```

(= 「ランダム効果 / 全体効果」 で 「誰に」 を省略するスキルは Phase 2 で追加予定。
本 SPEC では `単体ターゲット型` のみ。)

### 3-2. タップごとの挙動マトリクス

| 現在 state | タップ対象 | 結果 |
|---|---|---|
| idle | ally hero (行動可) | actor 選択 → state=actorSelected、 skills 表示 |
| idle | ally master | board に詳細表示のみ (= 行動不可、 view-only) |
| idle | enemy (任意) | board に詳細表示のみ (= view-only) |
| idle | sick / attacked ally | board に詳細表示のみ |
| idle | 手札カード | summoning → state=summoning |
| actorSelected | 別の ally hero | actor 切替 |
| actorSelected | 同じ ally hero | 解除 → state=idle |
| actorSelected | enemy / 自軍 master | board 詳細だけ更新、 actor 選択は保持 |
| actorSelected | skill 1 つ | state=skillSelected、 range を board に preview |
| skillSelected | 有効 target (= 1st 回) | state=targetPreview、 HP before/after を board に preview |
| skillSelected | 無効 target / 別 actor | actor 切替 / cancel |
| targetPreview | 同じ target (= 2nd 回) | 実行 → state=idle |
| targetPreview | 別の有効 target | 1st preview にリセット (= state=targetPreview) |
| 任意 state | 手札カード | summoning にスナップ (= 現在の actor chain は cancel) |
| 任意 state | End Turn | 全 cancel + ターン終了 |

### 3-3. 範囲 / HP プレビューの仕様

スキル選択時、 board に表示する:

- スキル名 + cost + 効果テキスト
- **有効 target に対応する instr-slot にハイライト** (`.instr-slot--valid-target`)
- ユーザー仕様 「効果が届く範囲」 = 「単体ターゲット型」 なら 1 件だけハイライト
- ユーザー仕様 「味方も判定対象に加えてよい」 = friendly fire を許可

target 選択 (= 1st tap) 時:

- 対象の portrait + name を board に大きく表示
- HP: `現在値 → 予想値`、 ダメージ量を強調
- 「もう一度タップで実行」 hint

## 4. スコープ

### In Scope (= 本 SPEC で実装)

- index.html: 3 ゾーンレイアウト + 各 instr-slot + skill chooser + board panel
- css/battle.css: 全面書き換え (= 旧 field-slot / battle-hand 中央配置から、 3 ゾーンに)
- js/battle/battle-ui.js: 全面書き換え (= 新 state machine + render 分離)
- js/battle/skill-registry.js 新規: スキル定義 (= cost / range / effect / target type 等の metadata)
- 「通常攻撃」 だけは **完全動作** (= 既存 `performAttack` を内部で呼ぶ)
- ヒーロー固有スキル (= シャーロック・ホームズ / 浪切 / 遼来遼来) は **chooser に表示するが disabled** (= Phase 2 SPEC-109 で actuation)
- sprite アニメ結線は新 layout に追従 (= attacker / target の instr-slot portrait を取得し直す)
- CPU AI (= cpu-turn.js) は **新 layout でアニメ用 DOM 参照だけ更新** (= AI ロジック自体は無改変)

### Out of Scope

- ヒーロー固有スキルの actuation (= Phase 2、 SPEC-109)
- ドラッグアンドドロップ (= ユーザー仕様 「OR タップ」、 タップで先行実装。 DnD は Phase 2 後で)
- AoE / random ターゲット型スキル (= 全体効果スキルの実装は Phase 2)
- master が active actor になる仕様 (= 現状は view-only)
- 効果アニメーション / パーティクル (= 既存 sprite トリガーで十分)
- リプレイ / 履歴

## 5. データ構造変更

### 5-1. skill-registry.js (= 新規)

各スキル id を key にした registry。 現状 4 件:

```js
export const SKILLS = {
  // 通常攻撃 (= 全ヒーロー共通、 card data には含まれない synthetic)
  "basic_attack": {
    id: "basic_attack",
    name: { ja: "通常攻撃", en: "Basic Attack" },
    cost: 0,
    targetType: "single_enemy",   // single_enemy / single_ally / single_any / self / aoe_enemy 等
    effectKind: "damage",          // damage / heal / buff
    description: { ja: "ATK 分のダメージを与える", en: "Deal damage equal to ATK" },
    implemented: true,
  },
  // 以下 3 件は MCH 公式 passive 名のまま hero-data から取得済み
  "sherlock_holmes": {
    id: "sherlock_holmes",
    name: { ja: "シャーロック・ホームズ", en: "Sherlock Holmes" },
    cost: 1,
    targetType: "single_ally",
    effectKind: "buff",
    description: { ja: "味方ヒーロー 1 体の ATK を +1 (= Phase 2)", en: "Boost ally ATK by +1 (Phase 2)" },
    implemented: false,
  },
  "namikiri": {
    id: "namikiri",
    name: { ja: "浪切", en: "Namikiri" },
    cost: 2,
    targetType: "single_enemy",
    effectKind: "damage",
    description: { ja: "通常攻撃 +1 ダメージ (= Phase 2)", en: "Basic attack +1 damage (Phase 2)" },
    implemented: false,
  },
  "ryorai_ryorai": {
    id: "ryorai_ryorai",
    name: { ja: "遼来遼来", en: "Ryorai-Ryorai" },
    cost: 2,
    targetType: "self",
    effectKind: "heal",
    description: { ja: "自身を 1 回復 (= Phase 2)", en: "Heal self for 1 (Phase 2)" },
    implemented: false,
  },
};

export function getSkillsFor(heroDef) {
  // 通常攻撃 を先頭にして、 hero.skills の id を resolve
  const out = [SKILLS["basic_attack"]];
  for (const s of (heroDef.skills || [])) {
    if (SKILLS[s.id]) out.push({ ...SKILLS[s.id], heroSkillRef: s });
  }
  return out;
}

export function getValidTargetsForSkill(battle, actorSide, actorSlot, skill) {
  // targetType に応じた slot 配列を返す ({side, slot}[])
  // 単体ターゲット型のみ実装、 詳細は実装側で
}
```

### 5-2. battle-ui state machine

```js
let _uiState = "idle";  // idle / summoning / actorSelected / skillSelected / targetPreview / gameOver
let _selectedHandIdx = -1;
let _selectedActor = null;     // {side, slot}
let _selectedSkill = null;     // skill object
let _previewTarget = null;     // {side, slot}
let _viewingTarget = null;     // 詳細パネルに表示中の {side, slot} (= 任意の選択と独立)
```

## 6. テスト計画

### 6-1. Node 側

- [ ] `getSkillsFor(heroDef)` で 通常攻撃 + hero.skills が返る
- [ ] `getValidTargetsForSkill(battle, actor, "basic_attack")` で `getValidAttackTargets(opponent)` と同じ slot 集合を返す
- [ ] skill-registry の 4 件全てが `id` / `name` / `targetType` / `effectKind` を持つ
- [ ] `computeSkillPreview(battle, actor, skill, target)` で 通常攻撃時に `{hpBefore, hpAfter, damage}` を正しく算出

### 6-2. ブラウザ手動

- [ ] 起動直後、 instr 6 枠 + 手札 + End Turn が見える、 board は turn info のみ
- [ ] 自軍 master タップ → board に master 詳細、 skill chooser は出ない
- [ ] 敵 master タップ → board に enemy master 詳細、 skill chooser は出ない
- [ ] 手札カードタップ → summoning state、 ally の対応 slot がハイライト
- [ ] 召喚成功 → 該当 instr-slot に portrait 表示
- [ ] 召喚酔いユニットタップ → board 詳細のみ (= skill chooser 出ない)
- [ ] T2 で召喚酔いが解け、 ユニットタップ → skill chooser に 「通常攻撃」 + 3 つの disabled スキル
- [ ] 通常攻撃タップ → board に「単体ダメージ」 範囲表示 + 敵 instr-slot がハイライト
- [ ] 有効 target タップ (1 回目) → board に HP before/after preview
- [ ] 同じ target 再タップ (2 回目) → 攻撃実行、 アニメ、 HP 反映
- [ ] 別の有効 target タップ → preview がそちらに移動 (= 1st tap state にリセット)
- [ ] 無効 target タップ → chain cancel または board 詳細だけ更新
- [ ] hero 固有スキル disabled (= グレーアウト + 「Phase 2」 表示)
- [ ] 手札カード タップ中に instr-slot タップ → 召喚 or キャンセル
- [ ] CPU ターン中は全タップが無視される
- [ ] JP / EN 切替で全テキストが追随
- [ ] mobile 375×667 で破綻なし、 PC で max-width 中央配置

## 7. PR 構成

- ブランチ: `claude/battle-ux-redesign`
- コミット 1: SPEC-108 docs + changelog fragment
- コミット 2: index.html の 3 ゾーンレイアウト書き換え
- コミット 3: css/battle.css 全面書き換え
- コミット 4: js/battle/skill-registry.js 新規 + 通常攻撃の preview/target 関数
- コミット 5: js/battle/battle-ui.js 全面書き換え (= 新 state machine + render 分離)
- コミット 6: cpu-turn.js の DOM 参照 selector を新 layout に追従
- コミット 7: data/i18n/ui.json に新キー追加
- コミット 8: SPEC-INDEX / CHANGELOG 再生成

## 8. 関連 SPEC

- SPEC-104: 旧 battle UI (= 本 SPEC で全面置換)
- SPEC-105: スプライトアニメ (= 結線先 DOM 参照のみ更新)
- SPEC-106: CPU AI (= 無改変、 cpu-turn.js の DOM selector 追従のみ)
- SPEC-107: 勝敗画面 (= 無改変、 finishBattle → showGameOverScreen 結線維持)
- **SPEC-109 (= 次)**: ヒーロー固有スキル actuation (= ally_atk_plus_1 / damage_plus_1 / self_def_plus_1 を本 SPEC の skill-registry に実装)
