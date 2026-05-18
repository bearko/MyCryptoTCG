# Spec-Driven Development (SDD)

このテンプレートは **Spec-First** を基本とする。 大きな機能追加 / バグ修正は Spec を書いてから実装する。

## 1. なぜ Spec-First か

- **思考整理**: 実装前に問題を分解できる
- **コミュニケーション**: PR レビュー時に「何を・なぜ・どう」 が一目で分かる
- **抜け漏れ防止**: テストケースを事前に列挙できる
- **再現可能性**: 後で似た機能を作るとき参照できる

## 2. Spec の単位

| 種別 | 例 | Spec を書くか |
|---|---|---|
| 大型機能 | クラフト機能新設 | ✅ 必須 |
| 中型機能 | 並列スロット追加 | ✅ 必須 |
| バグ修正 (= 影響大) | pauseFlags leak 修正 | ✅ 推奨 |
| バグ修正 (= 局所) | typo / className mismatch | ❌ 直接 PR |
| リファクタ | ファイル分割 | ✅ 推奨 |
| ドキュメント | README 修正 | ❌ 直接 PR |

## 3. Spec ファイルの場所

```
specs/
  SPEC-001-craft-system.md
  SPEC-002-quest-system.md
  SPEC-003-hire-system.md
  ...
  SPEC-006-parallel-slots.md
  SPEC-007-salary-popup-redesign.md
```

連番 + ハイフン区切り。 一度作った Spec は削除しない (= 履歴として残す)。

## 4. Spec のテンプレート

```markdown
# SPEC-NNN — <機能名>

- **Status**: Draft | InReview | Approved | Implementing | Done | Cancelled
- **Author**: bearko
- **Created**: 2025-XX-XX
- **Updated**: 2025-XX-XX

## 1. 背景 / 課題

<なぜこの機能が必要か / どんな問題を解くか>

## 2. ゴール

- <達成したい状態 1>
- <達成したい状態 2>

## 3. 非ゴール

- <やらないこと 1>
- <やらないこと 2>

## 4. ユーザー体験

### 4.1 シナリオ

<step by step で利用シナリオを書く>

### 4.2 UI モック

<ASCII art / 画像 / Figma URL>

## 5. 技術設計

### 5.1 データ

<state スキーマ・JSON 構造>

### 5.2 関数

| 関数名 | 役割 | 入力 | 出力 |
|---|---|---|---|
| `xxx()` | ... | ... | ... |

### 5.3 フロー

<sequence diagram or pseudocode>

## 6. 実装フェーズ

| Phase | 内容 | PR |
|---|---|---|
| 1 | データ構造定義 | #XX |
| 2 | コア logic 実装 | #XX |
| 3 | UI 統合 | #XX |
| 4 | i18n + テスト | #XX |

## 7. テストケース

- [ ] <ケース 1>
- [ ] <ケース 2>

## 8. リスク・懸念

- <既存機能への影響>
- <パフォーマンス>
- <Breaking change の可能性>

## 9. 参考

- <関連 Spec>
- <関連 Issue / PR>
- <外部資料>
```

## 5. ライフサイクル

```
Draft ──→ InReview ──→ Approved ──→ Implementing ──→ Done
                  └─→ Cancelled
```

- **Draft**: 著者が書いている最中
- **InReview**: PR で議論中
- **Approved**: マージ済み (= Spec 自体が main に入った状態)
- **Implementing**: 実装 PR が走っている
- **Done**: 全 Phase 完了 + 動作確認済み
- **Cancelled**: 採用しないことに決まった (= 削除せず履歴として残す)

## 6. Spec PR と実装 PR

### 6.1 別々に出す

```
PR #N:   docs(spec-006): Phase 0 — Add SPEC-006-parallel-slots.md
PR #N+1: feat(spec-006): Phase 1 — Add parallel slot accessors
PR #N+2: feat(spec-006): Phase 2 — UI integration
```

Spec PR を先にマージしてから実装 PR を出す。

### 6.2 Phase 分割の指針

- 1 PR の diff は **+500 / -200** 行以内が目安
- 各 Phase は単独でマージ可能 (= main に入っても壊れない)
- レビュー単位で意味的に区切る

## 7. Spec が「育つ」 場合

実装中に新しい知見が出たら Spec を更新:

```markdown
## 5. 技術設計 (Updated 2025-XX-XX)

~~初期案~~ → 最終案: ...

理由: 実装中に X の制約が分かったため
```

履歴を残すことで「なぜこの設計になったか」 が後から追える。

## 8. 大規模リファクタの場合

Spec を「親 Spec + 子 Spec」 に分割:

```
SPEC-100 — Refactor: extract event system   ← 親
  ├── SPEC-100a — Move event handlers to events.js
  ├── SPEC-100b — Define event types
  └── SPEC-100c — Migrate consumers
```

子 Spec は親の `## 6. 実装フェーズ` に列挙する。

## 9. AI ペアプロでの Spec 活用

Claude にタスクを渡すとき:

```
「SPEC-006-parallel-slots.md の Phase 2 (UI 統合) を実装してください」
```

Spec を参照してもらうことで:
- 余計な質問が減る (= context が明確)
- 設計のブレが減る (= 文書を共通言語にできる)
- 後から実装内容を検証しやすい

## 10. テンプレートからの起ち上げ

このテンプレートをコピーした直後の Spec は:

```
specs/
  SPEC-001-project-setup.md     ← 環境構築・命名・i18n
  SPEC-002-<game-feature-1>.md  ← 最初のゲームメカニクス
  ...
```

`SPEC-001` で「このプロジェクトの Charter (= ゴール)」 を確定し、 `SPEC-002` 以降でゲーム機能を一個ずつ刻んでいく。

## 11. SPEC-INDEX / CHANGELOG の自動生成 (= mycryptotemplate SPEC-001 / 元 MCS SPEC-032)

並列 PR で `SPEC-INDEX.md` と `CHANGELOG.md` の同じ行を取り合って毎回コンフリクトしていた問題を解消するため、 両ファイルは **SPEC ファイルの YAML frontmatter** と **per-SPEC の changelog fragment** から自動生成する。

### 11.1 ワークフロー

新規 SPEC PR では:

1. `docs/specs/SPEC-NNN-<topic>.md` を新規作成。 冒頭に YAML frontmatter:

   ```yaml
   ---
   id: SPEC-NNN
   title: 短いタイトル (= INDEX 表に出る、 SPEC タイトル本文と一致させる)
   status: Implementing       # Done / Cancelled に随時更新
   pr: feat/spec-NNN-topic    # PR 採番後に "39" 等の数値に更新
   phase: Phase 0 / Phase 1
   kind: Added                # Added / Changed / Fixed / Removed (CHANGELOG 見出し)
   ---
   ```

2. `docs/changelog/SPEC-NNN.md` を新規作成 (= bullet list **のみ**、 見出し行は不要)。

3. **`docs/specs/SPEC-INDEX.md` と `CHANGELOG.md` は触らない**。 それぞれの自動生成区間 (`<!-- BEGIN AUTO-* -->` ... `<!-- END AUTO-* -->`) の中身は、 後段で再生成される。

### 11.2 PR マージ後の手当て

マージ後、 自分の SPEC frontmatter を更新するために 1 行 PR を出すか、 メンテナーが定期的に:

```sh
node tools/build-spec-index.mjs
node tools/build-changelog.mjs
```

を実行して両ファイルを最新化する。 ツールは純 Node ESM (= 依存なし)、 コミットを 1 個追加するだけ。

### 11.3 並列 PR の衝突は構造的に不可能

PR-A と PR-B が同時に進んでいても:

- 各々が編集するのは **自身の SPEC ファイル** と **自身の fragment ファイル** のみ
- `SPEC-INDEX.md` / `CHANGELOG.md` は誰も編集しない (= 自動生成されたマーカー間)

→ ファイル単位で衝突源が分離される。 旧来の fresh-branch 戦略はもう不要。

### 11.4 行き先の対応表

| 旧来 (= 衝突あり) | 新ワークフロー |
|---|---|
| CHANGELOG.md の `[Unreleased]` 先頭に直接エントリ追加 | `docs/changelog/SPEC-NNN.md` を新規作成 |
| SPEC-INDEX.md の表に行追加 + 既存 SPEC を `Implementing → Done` に flip | SPEC ファイルの frontmatter を更新するだけ |
| `merged in #N` の手書きアノテーション | `status: Done` + `pr: N` で自動付与 |

### 11.5 marker の **行頭 anchor** に注意

`tools/build-*.mjs` は `<!-- BEGIN AUTO-* -->` ... `<!-- END AUTO-* -->` を **行頭一致** で検出する (= `findLineAnchored()`)。 fragment 本文中に同じ marker 文字列が登場しても (= 例: 解説で marker を引用しても) **誤マッチしない**。

