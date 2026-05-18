---
id: SPEC-100
title: MyCryptoTCG 3 日リリース計画 (= Day 1〜Day 3 の Phase 配分)
status: Approved
pr: claude/import-kickoff-document-bQ6rP
phase: Phase 0
kind: Added
---

# SPEC-100 — MyCryptoTCG 3 日リリース計画

## 1. 目的

`MYCRYPTOTCG-KICKOFF.md` 5 章 「Day 1 MVP スコープ」 を起点に、 **Day 1〜Day 3
の 3 日間で 1 バトルデモを動く状態にする** ためのフェーズ配分を確定する。

このファイル自体は計画 (= meta SPEC) であり実装は含まない。 各 Day の実装は
配下の SPEC-101 以降で個別に PR 化する。

## 2. Day 別 Phase 配分

| Day | SPEC | Phase | 範囲 | 完了基準 |
|---|---|---|---|---|
| Day 1 | SPEC-101 | Phase 0 | prefix `mctcg` 置換 + `PROJECT_CHARTER.md` 書き換え + `index.html` meta 更新 | Console エラーなしで起動、 charter に MCT の目的/スコープ/勝利条件が記述 |
| Day 1 | SPEC-102 | Phase 1A | カード JSON (= ヒーロー 3 体 + マジック 2 種) + デッキ state | `data/cards/*.json` 取得 → `state.deck` / `state.hand` 初期化 + unit test (= console での dump) |
| Day 1 | SPEC-103 | Phase 1B | ターンシステム + ドロー / 補充 / 召喚 / 攻撃ロジック | 自ターン: draw → stones+3 → summon → attack → end → 相手ターン、 マスター HP 0 で勝敗判定 |
| Day 2 | SPEC-104 | Phase 1C | バトル画面 UI (= 手札 / 場 / マスター枠) + タップ操作 | 手札タップで召喚プロンプト、 場のヒーロータップで攻撃対象選択、 i18n JP/EN 切替 |
| Day 2 | SPEC-105 | Phase 1D | スプライトアニメ (= `idle` / `attack` / `hit`) + 3 体分 | `attachSprite()` + `triggerAttackAnim()` + プレースホルダ PNG (= 64×64 strip) 3 体 |
| Day 3 | SPEC-106 | Phase 1E | CPU AI (= ルールベース、 弱め) | ストーン余れば召喚 / 召喚酔いなければ攻撃 / マスター直撃可能ならそれ優先 |
| Day 3 | SPEC-107 | Phase 1F | 勝利 / 敗北画面 + タイトル復帰 + ランキング送信 UI スタブ | 勝利時にスコア表示 + 「タイトルに戻る」 ボタン、 ranking URL 未設定でも UI スタブが動く |

## 3. スプライト先行ヒーロー 3 体 (= ユーザー指示で Claude が選定)

| 採用 | MCH heroId | 採用理由 |
|---|---|---|
| 1 体目 | `1` (= MCH DB の先頭) | DB 検証の代表サンプル、 必ず存在 |
| 2 体目 | `2` | 同上、 ATK 系想定 |
| 3 体目 | `3` | 同上、 デッキ多様性のため |

正式名 (= `name.ja` / `name.en`) は **SPEC-102 (= Phase 1A) でデータ取込時に
`bearko/mycryptoheroes` の master データから引用** する。 オリジナル名を Claude
が付けることは禁止 (= `CLAUDE.md` MCH 経済圏遵守)。 同名禁止ルールに引っかかる
場合は番号を 4, 5, ... と繰り上げて 3 体確保。

スプライト本体 (= `assets/sprites/heroes/<heroId>/idle.png` 等) は **Day 2
SPEC-105 でプレースホルダ PNG** (= 64×64 × フレーム数の単色ストリップ) を
コミットする。 本格的な pixel art への差替えは Phase 2 以降。

## 4. リスクと前提

- **MCH master DB 取得**: `bearko/mycryptoheroes` の raw URL がアクセス可能で
  あること。 fetch 失敗時は fallback で空配列にし、 SPEC-102 のテストを
  console 警告のみで pass させる
- **3 体のスプライトはプレースホルダで可**: Day 2 のゴールは 「パイプラインが
  動く」 ことであり、 アートのクオリティはスコープ外
- **CPU AI は最弱でよい**: Day 3 のゴールは 「ゲームとして終わる」 ことであり、
  バランス調整は SPEC-008 以降
- **ランキング送信は UI スタブのみ**: backend B (= Upstash + Vercel) の正式
  デプロイは別 SPEC (= SPEC-013) で扱う。 Day 3 では `_DEFAULT_API_URL_ENC = ""`
  のままで 「送信」 ボタンは disabled もしくは 「未設定」 表示

## 5. 進捗トラッキング

各 SPEC が Done になるたび本ファイルの 2 章テーブルの状態列を **手で `Done` に
更新** ではなく、 配下 SPEC の frontmatter の `status` を Done に更新するのみ。
本ファイルは計画固定 (= 後から書き換えない)。

## 6. 関連ドキュメント

- `MYCRYPTOTCG-KICKOFF.md` — 企画書 (= 本計画のソース)
- `docs/charters/PROJECT_CHARTER.md` — Day 1 SPEC-101 で書き換える
- `docs/specs/SPEC-101-project-charter-and-prefix.md` — Day 1 Phase 0 実装
- `docs/specs/SPEC-INDEX.md` — 全 SPEC 一覧 (= 自動生成)
