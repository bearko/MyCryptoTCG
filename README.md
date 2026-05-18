# mycryptogame-template

**vanilla JS / 静的 HTML で動く web ゲーム** を Claude Code で開発するためのテンプレート。

MyCryptoTactics (PvP 戦術カード) と MyCryptoFactory (経営シム) の 2 作品で蓄積した
設計判断・実装パターン・運用作法を集約しています。

> **想定読者**: bearko 本人 + Claude Code エージェント
> **想定範囲**: モバイル/PC 両対応の 2D web ゲーム (= ビルドステップなし、 静的 host)
> **継承ジャンル**: パズル / カード / シム / RPG / アドベンチャー など (= 戦闘描写は簡易、 経済圏とランキングを軸に)

## このテンプレートを使うと得られるもの

- **動作環境**: PC + スマホ両対応 (= viewport / clamp / overflow 設計済み)
- **多言語**: ja / en の i18n 基盤 (= `t(key)` + `data-i18n` 属性で DOM 自動更新)
- **タイトル画面**: ロゴ + 版数バッジ + 言語トグル + ランキングボタン
- **ヘッダー**: バッジ + 通貨 + ヘルプ + ランキング + アクティブ効果ボタン
- **モーダル**: 共通 z-index 階層 + 背景クリック / Esc で閉じる + 多段階チェーン
- **時間制御**: `pauseFlags` カウンタ式 + `maiSays` の二重 pause 防止
- **エフェクト**: Confetti + sprite float + CSS @keyframes 実装例
- **音響**: BGM (= タイトル dismiss で unlock) + SE 関数群 + throttle
- **ランキング**: GAS web app 連携 (= base64 URL + localStorage 上書き) + デプロイ手順
- **テスト**: シード乱数シミュレータ + 手動 QA チェックリストひな型
- **開発フロー**: SPEC 駆動 + Conventional Commits + PR テンプレ + ブランチ戦略

## クイックスタート

### 1. このテンプレートからプロジェクトを作る (= GitHub UI 推奨)

1. GitHub で https://github.com/bearko/mycryptotemplate を開く
2. リポジトリ TOP の緑の **「Use this template」 → 「Create a new repository」** をクリック
3. Owner: `bearko` (= またはあなたのアカウント) / Repository name: `mycryptoxxx` / Public で作成
4. 作成したリポジトリをローカルにクローン

```bash
git clone https://github.com/bearko/mycryptoxxx
cd mycryptoxxx
```

注: 「Use this template」 ボタンが見えない場合は、 テンプレート repo の **Settings → General → Template repository** にチェックを入れると有効化されます (= 一度設定すれば以降の派生で再利用可能)。

(gh CLI で済ませる場合は `gh repo create bearko/mycryptoxxx --template bearko/mycryptotemplate --public --clone` でも可)

### 2. Claude Code 新セッションを開く (= MCP スコープ切替)

1. Claude Code (Web もしくは CLI) を起動
2. **GitHub MCP の接続先を、 さっきコピーした新リポジトリ (`bearko/mycryptoxxx`) に切替**
   - (= テンプレート repo のままだと PR / push 先がテンプレートに行ってしまうので必須)
3. 新セッションで、 下記の **「Day 1 Project Kickoff プロンプト」** に必要事項 (= プロジェクト名 / ジャンル / 必須機能 等) を埋めて投下

Claude が CLAUDE.md → AGENTS.md → docs/charters → docs/patterns の順に読み込み、 本テンプレートが規定する設計規則の中で実装を進めます。 識別子リネームや i18n 初期化、 Day 1 モック実装、 SPEC-001 起票までを 1 セッションで完了します。

### 3. Day 1 Project Kickoff プロンプト (= コピペして `<FILL: ...>` を埋める)

````markdown
# Day 1 Project Kickoff — <FILL: PROJECT_NAME>

私は `mycryptotemplate` をベースに新規ゲームプロジェクトを立ち上げます。
あなたは私のペアプロパートナーとして、 以下の手順で **Day 1 のモック** を構築してください。

---

## ⚠ 最重要 — 着手前に必ず読むこと

以下のドキュメントを **この順序で** 読み、 それに従って作業してください。
まだ読んでいない状態で実装を始めないでください。

1. `README.md`
2. `CLAUDE.md`(= 命名規則・規約・必読リスト)
3. `AGENTS.md`(= Sub-agent 活用ガイド・HITL ルール)
4. `docs/charters/PROJECT_CHARTER.md`(= テンプレート、 これから埋める)
5. `docs/charters/DEVELOPMENT_CHARTER.md`
6. `docs/charters/DESIGN_CHARTER.md`
7. `docs/patterns/01-environment-and-assets.md`
8. `docs/patterns/02-screen-structure.md`
9. `docs/patterns/03-i18n-and-help.md`
10. `docs/patterns/04-time-and-modals.md`(= pauseFlags パターン必読)
11. `docs/process/SPEC_DRIVEN_DEVELOPMENT.md`
12. `docs/setup/new-project.md`

**複数ファイルの読み込みは `Explore` sub-agent に依頼して、 要約だけ受け取ってください**(= context 節約)。

---

## 1. プロジェクト基本情報

- **プロジェクト名**: <FILL: 例 MyCryptoQuest>
- **タグライン (1行)**: <FILL: 例 マイクリヒーローと挑むダンジョン経営>
- **ジャンル**: <FILL: 例 タワーディフェンス + 経営シム>
- **参考タイトル**: <FILL: 例 Slay the Spire / Loop Hero / マイクリ既存タイトル>
- **コアゲームループ (3文)**:
  <FILL:
  1. プレイヤーは○○する
  2. その結果○○が起きる
  3. それを使って○○を強化する
  >
- **対象プラットフォーム**: <FILL: PC + Mobile / PC のみ>
- **対応言語**: <FILL: JP のみ / JP+EN>
- **ビジュアルトーン**: <FILL: 例 ダークファンタジー / ポップ / ピクセル / ミニマル>

## 2. 機能スコープ

### 必須機能(= MVP に含む、 3〜5個)
- <FILL: 機能1>
- <FILL: 機能2>
- <FILL: 機能3>

### 仕組み採否
- 時間進行 (= ホーム画面で待機中のみ tick): <FILL: YES / NO>
- ランキング (= 既定 = Upstash + Vercel / 代替 = GAS): <FILL: YES (default backend = Upstash) / YES (GAS で実装) / NO / 後で>
- 多言語切替: <FILL: JP only / JP+EN>
- セーブ/ロード: <FILL: YES / NO / 後で>
- 月次イベント (= 年単位ループ): <FILL: YES / NO>
- 並列スロット (= MCF の並列クラフト的): <FILL: YES / NO>

### 非ゴール(= MVP では作らない)
- <FILL: やらないこと1>
- <FILL: やらないこと2>

## 3. 技術設定

- **localStorage prefix**: <FILL: 例 mcq>(= 3〜5文字、 他作品とぶつからないもの)
- **アセットCDN**: <FILL: ./assets/ または https://raw.githubusercontent.com/.../main/>
- **GitHubリポジトリ**: <FILL: bearko/mycryptoxxx>
- **ローカル作業パス**: <FILL: 例 C:\dev\mycryptoxxx>

## 4. ターゲット体験(= プレイヤーが最初の60秒で得る感覚)

<FILL:
例 タイトルを開く → Press to Start → ホーム画面で施設タイル3つ + ヒーローパネル
→ 最初のヒーロー獲得チュートリアル発火 → ダンジョン1階に挑戦できる
>

---

## 5. Day 1 の到達点

以下を満たすモックを作ってください。

- [ ] `index.html` をブラウザで開いて Console エラーなく表示
- [ ] Splash → Title → Home画面 の遷移
- [ ] JP/EN 切替が動く(必要な場合)
- [ ] ヘッダー + 時間表示 + ヘルプボタン
- [ ] モーダル1つ以上を pause/resume パターン通りに開閉(= ヘルプ可)
- [ ] **必須機能のうち少なくとも1つの "見た目だけのスタブ"** が存在(= ボタン押下で空モーダル等でOK)
- [ ] PC(1280×800)+ Mobile(375×667)両方で破綻しない
- [ ] `specs/SPEC-001-project-setup.md` 作成、 ステータス Done

## 6. 進め方

1. **必読ドキュメントを読む**(上記順序、 `Explore` agent 推奨)
2. **AskUserQuestion で曖昧な点を確認**(例:「タイトルロゴはプレースホルダで良いか?」)
3. **`<prefix>` を一括置換**(= 上記指定の prefix で)
4. **`docs/charters/PROJECT_CHARTER.md` を埋める**(= 上記情報ベース)
5. **`specs/SPEC-001-project-setup.md` を作成**(= テストケース付き)
6. **Phase 1 PR**: タイトル + i18n + ホーム骨組み(= "Day 1 モック")を `feat/spec-001-phase-1-bootstrap` ブランチで draft PR 化
7. **次のSPEC-002の骨子だけ提示**(= Phase 2着手は私が GO を出してから)

## 7. 守ってほしい事項(= 規約)

- `CLAUDE.md` の命名規則(動詞prefix: trigger/open/close/render/pick/apply/find/get/set/tick/is)
- `pauseFlags` パターン(= `docs/patterns/04-time-and-modals.md`)厳守
- 1 PR = 1 論理変更、 Phase 分割
- **main / prod に直push禁止**、 必ず feature ブランチ + PR
- `console.log` / TODO 残しは commit 前に削除
- DEBUG_* フラグで囲んだログ以外は出さない
- `ASSET_BASE` / `img()` / `audioUrl()` を `js/constants.js` に集約
- 画像/音声のフォールバック(= ロード失敗で真っ白にしない)を必ず入れる
- Conventional Commits + Phase tag(例 `feat(spec-001): Phase 1 — Bootstrap title screen`)
- 共著者として `Co-Authored-By: Claude ...` をコミットメッセージに付ける

## 8. 質問してほしいタイミング(= 推測しないで)

以下のいずれかなら **必ず AskUserQuestion で確認**、 勝手に決めないでください:

- 必須機能の挙動が私の文章から1通りに定まらない
- ビジュアル/UIで複数解釈が成立する
- アセット(= 画像/音声)の入手元・既存パスが不明
- 規約違反になる可能性のある実装判断
- 私が指定していない技術的選択(例: フォーム validation の有無)

## 9. context 節約のお願い

- ファイル全文 Read は避ける、 必要なら `offset/limit` で部分読み
- 5ファイル以上の探索は **Explore agent** に依頼(= 結果サマリだけ受け取る)
- 設計を固める段階では **Plan agent** を一回呼ぶ
- 実装中の console 出力は要約で持ち帰る(= 200行超 paste しない)
- 大量ログは Grep の `head_limit` / `pattern` で絞ってから読む

## 10. 成果物(= 1セッション完了時に揃っているべきもの)

- [ ] `PROJECT_CHARTER.md` 埋まっている
- [ ] `specs/SPEC-001-project-setup.md` ステータス Done
- [ ] Phase 1 PR が draft で上がっている(= 私がレビューして merge)
- [ ] 次の `SPEC-002-<feature>.md` の見出しと骨子だけ提示
- [ ] Vercel preview URL を私が手動で確認できる状態(= vercel link 済み前提)

それでは、 **まず必読ドキュメントを `Explore` で読んで、 その後に基本情報の認識合わせの質問** から始めてください。
````

(= プロンプト本文は `<FILL: ...>` を全て置換してから投下してください。 識別子リネーム / i18n / Day 1 モック / SPEC-001 までを Claude が自走します)

## ディレクトリ構造

```
README.md                       本ファイル
CLAUDE.md                       Claude Code 開発ガイド (= 最初に読むファイル)
AGENTS.md                       AI エージェント運用規約
.gitignore
.github/
  PULL_REQUEST_TEMPLATE.md
.claude/
  settings.json                 permission allowlist + hooks
  skills/                       カスタムスキル (任意)
docs/
  charters/
    PROJECT_CHARTER.md          プロジェクトの目的・スコープ・成功基準
    DEVELOPMENT_CHARTER.md      開発の暗黙の作法 (= 必読)
    DESIGN_CHARTER.md           UI/UX 規範
  patterns/
    01-environment-and-assets.md
    02-screen-structure.md
    03-i18n-and-help.md
    04-time-and-modals.md
    05-effects-audio-ui.md
    06-state-and-data.md
    07-ranking-integration.md
    08-dev-conventions.md
  process/
    SPEC_DRIVEN_DEVELOPMENT.md
    GIT_WORKFLOW.md
  testing/
    TESTING_STRATEGY.md
    TEST_CASES.md
  setup/
    new-project.md              新規プロジェクト初期化手順
    google-apps-script.md       ランキング GAS デプロイ手順
  specs/
    SPEC-INDEX.md               (新規追加: SPEC を 1 行ずつ並べる)
index.html                      エントリポイント (タイトル/ヘッダー/views 雛形)
js/
  main.js                       state + onTick + 画面 routing 雛形
  constants.js                  ASSET_BASE + img()/audioUrl()
  i18n.js                       multi-locale 基盤
  ranking-client.js             GAS 連携クライアント
  effects.js                    confetti + sprite float
  data-loader.js                JSON loader (heroes 等の汎用パターン)
data/
  i18n/
    ui.json                     UI 文字列 (ja/en object 形式)
  sample-entities.json
tools/
  sim/
    README.md                   シミュレータ実装ガイド
og-image.png                    OG 画像 placeholder
```

## ライセンス

bearko 個人テンプレート。 派生作品の license は各プロジェクトで指定してください。
本テンプレート自体に依存する外部素材 (= MCH 公式 CDN 等) は、 各プロジェクトの規約に従って参照すること。

## 関連リポジトリ

- `bearko/mycryptotactics` — 戦術カードゲーム (本テンプレートの源流 1)
- `bearko/mycryptofactory` — 経営シム (本テンプレートの源流 2)
- `bearko/aidev_template` — bearko の AI 開発全プロジェクト共通の運用ベース
