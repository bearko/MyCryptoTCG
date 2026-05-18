# Claude Code 開発ガイド

このファイルは **本リポジトリで Claude Code を起動した際に最初に参照されるべきガイド** です。
派生プロジェクトでも、 この CLAUDE.md と `docs/charters/` の規範を最優先に従って実装してください。

## 必読順序

新規セッションで Claude が読むべき順番:

1. **本ファイル (CLAUDE.md)** — 全体観
2. **`docs/charters/PROJECT_CHARTER.md`** — プロジェクトの目的・スコープ
3. **`docs/charters/DEVELOPMENT_CHARTER.md`** — 開発の作法 (必読、 暗黙の了解集)
4. **`docs/charters/DESIGN_CHARTER.md`** — UI/UX 規範
5. **`docs/process/SPEC_DRIVEN_DEVELOPMENT.md`** — 仕様駆動の流れ
6. **`docs/process/GIT_WORKFLOW.md`** — コミット / ブランチ / PR
7. **`docs/patterns/*.md`** — 個別実装パターン (= 該当する作業のときだけ参照)
8. **`docs/specs/SPEC-INDEX.md`** — プロジェクト固有の SPEC 一覧

## 技術スタック (= 不変、 変更には合議が必要)

- **プレーン ES Modules + バニラ JS** — TypeScript / バンドラ / フレームワーク **なし**
- **HTML 単一エントリ** (`index.html`)
- **静的ホスティング前提** — Vercel / GitHub Pages / Cloudflare Pages 等で `build:` 不要
- **データは `data/*.json` から runtime fetch**
- **外部素材は CDN URL 参照** (= リポジトリにバイナリは置かない)
- **音声・画像は `js/constants.js` の `ASSET_BASE` 経由**

これらは派生プロジェクトでも **基本的に変えないでください**。 変更したい場合は新規 SPEC で合意を取ってからにすること。

## MCH 経済圏の遵守 (= 名称・アイコン・データベース)

本テンプレートを使う派生プロジェクトは、 **MyCryptoHeroes (= MCH) の世界観を継承** します。
特別な指示がない限り、 **オリジナル名称や独自アイコンは使わず**、 MCH の用語・アイコン・データを参照してください。

### リファレンス

- **マスター DB**: https://github.com/bearko/mycryptoheroes
  - ヒーロー / エクステンション / スキル / エネミーの正式名称・パラメータ・アイコン URL
  - 派生プロジェクトでは `js/constants.js` の `ASSET_BASE` をこの repo の raw URL に向ける構成を推奨

### 名称統一 (= 必ずこの呼称を使う)

| 概念 | 呼称 | 不可な代替 (= 使わないこと) |
|---|---|---|
| ゲーム内通貨 | **GUM** | コイン / ゴールド / マネー |
| 経験値 | **CE** | EXP / Lv ポイント / 経験ポイント |
| キャラクター | **ヒーロー** | キャラ / ユニット / 駒 |
| 武器 / アイテム | **エクステンション** | 装備 / アイテム / 武具 / ギア |
| 敵キャラ | **エネミー** | モンスター / 敵 / 邪悪 (= ボスは文脈で可) |

(= i18n キー設計 / 変数名 / UI 文言 / ヘルプ文 / コミットメッセージすべてでこの呼称を使うこと)

### アイコン

各概念に対応するアイコンも MCH 公式のものを使う:
- GUM アイコン / CE アイコン / ヒーロー画像 / エクステンション画像 / エネミー画像
- すべて `js/constants.js` の `ASSET_BASE` 経由で URL 解決
- 独自描き起こしアイコンは原則禁止 (= 必要な場合は SPEC で議論してから)

### ヒーロー名 / エクステンション名 / スキル名

オリジナル名称は使わず、 必ず https://github.com/bearko/mycryptoheroes 内のデータベース (= JSON / マスター CSV 等) から引用してください。

- 例 (= ダメな書き方): 「炎の剣」 「火球の術」 のような **架空の MCH 風名称** を Claude が勝手に作る
- 例 (= 正しい書き方): MCH 既存のエクステンション名・スキル名をそのまま流用する
- 新ヒーロー / 新エクステンション / 新スキルを追加したい場合は **必ず SPEC で合意** してから (= MCH 設定との整合確認が必須)

## やってはいけないこと

- `package.json` を導入して npm dependency を増やす (= ビルドステップが発生する)
- 外部画像/音声をリポジトリに直接コミットする (= raw CDN URL を使う)
- `.env` / 認証情報をコミットする
- `git push --force` を main / prod に行う (= 必ず PR で)
- コミットメッセージから `Co-Authored-By: Claude` を消す
- `.claude/settings.json` を勝手に書き換える (= 権限 escalation)
- **絵文字を出力に含める** (= UI / ドキュメント / コミットメッセージ / Claude の応答すべて。 ユーザーから明示的に絵文字使用を指示された場合のみ可)
- **MCH の名称規約から逸脱したオリジナル用語を作る** (= 「コイン」 「EXP」 「アイテム」 等。 上の MCH 経済圏の遵守 を参照)

## ランキング機能の実装方針 (= 派生プロジェクトでのデフォルト)

派生プロジェクトでランキング機能を実装する場合、 **特別な指示が無い限り
Backend B (= Upstash Redis + Vercel Function)** を選択すること。 詳細は
`docs/process/RANKING_SETUP.md` の 0 章 (= 比較表) と 1〜7 章 (= Backend B) を参照。

### 着手時の振る舞い

ユーザーが 「ランキング機能を追加したい」 「スコア送信を入れたい」 等を言ったら、
Claude は **以下の順** で進めること:

1. **AskUserQuestion で backend を確認** (= 既定推奨を提示):
   - 選択肢 A: **Backend B (Upstash + Vercel)** (Recommended)
   - 選択肢 B: Backend A (GAS + Spreadsheet) (= Vercel を使わない場合)
   - 選択肢 C: 後で決める (= スタブだけ入れて URL 未設定で開始)
2. **Backend B を選ばれた場合**、 Vercel + Upstash の設定手順を **ユーザーに 1 ステップずつ
   提示** し、 各 step の完了を AskUserQuestion で確認しながら進める:
   - **Step 1**: Vercel ダッシュボード → 対象 project → **Storage** タブ →
     **Create Database** → **Marketplace Database Providers** → **Upstash for Redis**
     を選択 (= Free プラン、 リージョンは日本ユーザーなら ap-northeast-1)
   - **Step 2**: 作成すると環境変数 `UPSTASH_REDIS_REST_URL` /
     `UPSTASH_REDIS_REST_TOKEN` が **自動注入** される (= Vercel project の
     Settings → Environment Variables で確認可能)
   - **Step 3**: ローカル repo で `mkdir -p api && cp tools/vercel-ranking.js api/ranking.js`
     を実行し、 `git add api/ranking.js && git commit` でコミット
   - **Step 4**: `git push` → Vercel が自動 deploy (= 静的フロントは CDN、
     `api/*.js` は Node 18+ serverless function として展開)
   - **Step 5**: 動作確認: ブラウザで
     `https://<project>.vercel.app/api/ranking?limit=5` を開き
     `{"ok":true,"ranking":[]}` が返ることを確認
   - **Step 6**: クライアントの URL 設定: `js/ranking-client.js` の
     `_DEFAULT_API_URL_ENC` に `"L2FwaS9yYW5raW5n"` (= `btoa("/api/ranking")`)
     を埋め込むか、 ユーザーの DevTools で
     `localStorage.setItem("<prefix>.rankingApiUrl", "/api/ranking")` を実行
3. **Backend A を選ばれた場合** は `docs/process/RANKING_SETUP.md` の 8〜17 章
   (= Backend A) を参照しながら GAS デプロイ手順をユーザーに提示
4. **後で決める** を選ばれた場合は SPEC に 「ranking: 未決」 を記述し、
   `_DEFAULT_API_URL_ENC = ""` のままで UI のスタブだけ入れる

(= この振る舞いは新セッション開始時にユーザーが明示的に override しない限り
適用される。 派生プロジェクトの CLAUDE.md で上書きすることも可)

## 作法 (= 暗黙の了解)

詳細は `docs/charters/DEVELOPMENT_CHARTER.md` を参照。 要点だけ:

### 関数命名

| 接頭辞 | 用途 | 例 |
|---|---|---|
| `trigger*` | イベントを起動 (内部で pauseTime 含む) | `triggerCraftCompletion` |
| `open*` / `close*` | Modal の表示制御 | `openCompletionScreen` / `closeAppraisalScreen` |
| `render*` | DOM 描画 (state を反映) | `renderHeader` / `renderQuestCard` |
| `pick*` | ユーザー選択を state に記録 | `pickCommission` / `pickHeroForTeam` |
| `apply*` | state 変化を確定 (= 金銭/コミット) | `applyFactoryLvUp` / `applySalary` |
| `find*` | condition で検索 (= 新オブジェクト返却) | `findEmptyCraftSlot` / `findActiveHero` |
| `get*` / `set*` | accessor / mutator | `getActiveCraft(idx)` / `setActiveCraft(idx, ac)` |
| `tick*` | 毎 tick の simulation | `tickActiveCraft(idx)` / `tickPassiveRestRecovery` |
| `is*` / `can*` | bool を返す predicate | `isExtUnlocked` / `canSellExt` |

### i18n キー

階層: `<feature>.<context>.<aspect>` 例:
- `quest.mai.success` (= クエスト feature の Mai セリフの success ケース)
- `enhance.rankUpBtn` (= 強化画面のランクアップボタン)
- `mai.craftBusy` (= Mai キャラの craftBusy セリフ、 prefix `mai.` 専用)

形式: 文字列か object (`{"ja":"..","en":".."}`)。 後者は i18n.js の `t()` で lang-aware lookup。

### Phase 表記

機能群を Phase でまとめて記録 (= `Phase 0` / `Phase 1A` / `Phase 1D-42` / `Phase β2-3 part 2` 等)。
`docs/specs/SPEC-NNN.md` の表題と commit message に Phase を入れる。

### コミットメッセージ

Conventional Commits + Phase ラベル + Co-Author:

```
feat(spec-006): Phase 1D-42 — 月次イベント / 経験値 / クエスト再出発

- Implement triggerAnnualSalary
- ...

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

### Pause/Resume 不変条件

`pauseTime()` と `resumeTime()` は **必ず対** で呼び出す。 modal 開閉に紐づける場合:

```js
// Modal を開くとき
function openMyModal() {
  pauseTime();
  $("#myModal").classList.remove("hidden");
}

// Modal を閉じるとき (= 必ず resumeTime)
function closeMyModal() {
  $("#myModal").classList.add("hidden");
  resumeTime();
}
```

`maiSays`/`maiSaysSequence` は **既に paused なら自前 pause を skip** する設計 (= MCF Phase 1D-47 fix)。 これにより呼出側 pre-pause と modal 連鎖の両立が成立。

詳細: `docs/patterns/04-time-and-modals.md`

## 作業の進め方

1. ユーザーが「X を実装したい」 と言う
2. Claude は **まず SPEC を書く** か、 既存 SPEC があるか確認
3. SPEC のレビュー → 承認 → 実装
4. 実装は **小さい PR** に分割 (= 1 PR 1 SPEC、 巨大 PR 禁止)
5. PR には **テスト計画** を Test plan セクションで記載
6. ユーザーがマージ → Claude は次タスクへ

### PR で触るファイル / 触らないファイル (= SPEC-001 で導入)

並列 PR の衝突を構造的に避けるため、 一覧ファイル (= SPEC-INDEX / CHANGELOG)
を直接編集せず、 SPEC ごとの「自分専用ファイル」 だけを触る運用にする。

**触る (= 自分の SPEC 専用)**

- `docs/specs/SPEC-NNN-<topic>.md` — YAML frontmatter + 本文を新規作成
- `docs/changelog/SPEC-NNN.md` — bullet list の fragment を新規作成
- 実装ファイル (`js/...` `css/...` `data/...` 等)

**触らない (= 自動生成区間)**

- `docs/specs/SPEC-INDEX.md` の `<!-- BEGIN AUTO-INDEX -->` ... `<!-- END AUTO-INDEX -->` 区間
- `CHANGELOG.md` の `<!-- BEGIN AUTO-UNRELEASED -->` ... `<!-- END AUTO-UNRELEASED -->` 区間

両ファイルは `node tools/build-spec-index.mjs` / `node tools/build-changelog.mjs`
で再生成する (= 純 Node ESM、 依存なし)。 マージ後に Claude / メンテナーが
定期的に走らせ、 1 行 PR としてコミットする。

詳細: `docs/process/SPEC_DRIVEN_DEVELOPMENT.md` 11 章

## デバッグの際のチェックリスト

- 「時間が止まる/止まらない」 → `pauseFlags` の counter を console.log で確認
- 「Modal が裏で時間進行」 → modal opener が pauseTime を呼んでいるか
- 「翻訳が出ない」 → `data-i18n` 属性が設定されているか + `applyDataI18n()` が呼ばれているか
- 「画像が出ない」 → `img()` 経由で URL 解決しているか + onerror フォールバックがあるか
- 「ランキングに送信できない」 → `getRankingApiUrl()` が non-null を返すか (= localStorage か `_DEFAULT_API_URL_ENC`)

## 困ったとき

- **設計判断で迷う** → `docs/charters/` を参照、 それでも解決しないなら SPEC で議論
- **既存パターンの応用** → `docs/patterns/` の該当章 + MCT/MCF コードベースを grep
- **ユーザーへの提案** → 「複数案を提示 → ユーザー選択」 の形 (= 一方的に決めない)
- **大きな refactor** → 必ず段階的に。 1 PR で 100+ 箇所変更は禁止 (= MCF の `state.activeCraft` → array 化のような場合は accessor 関数で互換維持しながら段階移行)
