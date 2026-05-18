# 開発憲章 — 暗黙の了解集

> **必読**。 派生プロジェクトでも基本そのまま継承可能なルール集です。
> 特定プロジェクトで例外を作る場合は、 個別 SPEC で記録すること。

## 0. 大原則

### 0.1 Spec-First Development

「実装してから仕様を書く」 ではなく、 「**仕様を書いてから実装する**」。

- 新機能 → `docs/specs/SPEC-NNN-<topic>.md` を先に書く
- SPEC が承認 (= マージ) されてから実装 PR を出す
- 実装 PR には対応 SPEC を明記
- ユーザーが「すぐ実装して」と言っても、 重要機能は SPEC を先に書くと効率がいい

### 0.2 Small PR

1 PR = 1 SPEC = 1 機能。 100+ 箇所変更するような refactor は **必ず段階分割**:

1. accessor 関数を追加 (= API 層を増やす、 既存コードはまだ触らない)
2. 主要呼び出しサイトを accessor 経由に置換
3. 残りの呼び出しサイトを順次置換
4. 旧 API を削除

MCF Phase β2-3 (= 並行クラフトスロット) はこのパターンで実装した。

### 0.3 Defensive Coding

- すべての fetch は `.catch(() => fallback)` を持つ
- 画像は `onerror="this.style.opacity='0.2'"` でフォールバック
- localStorage は `try/catch` で囲む
- audio.play() は `.catch(() => {})` で再生失敗を無視
- pauseFlags は `Math.max(0, ...)` で負値を防止

### 0.4 No Build Step

- npm install を要求するものは追加しない
- TypeScript / Babel / Webpack は不要
- 必要な機能は **vanilla JS で実装**
- 例外: `tools/sim/` 配下のオフライン実行スクリプトは Node.js 標準 API のみ使用

## 1. 関数命名

| 接頭辞 | 意味 | 例 |
|---|---|---|
| `trigger*` | イベントを起動 (内部で pauseTime 含む) | `triggerCraftCompletion` / `triggerConfetti` |
| `open*` / `close*` | Modal の表示制御 (= pauseTime/resumeTime ペア) | `openCompletionScreen` / `closeAppraisalScreen` |
| `render*` | DOM 描画 (= state を反映) | `renderHeader` / `renderQuestCard` |
| `pick*` | ユーザー選択を state に記録 | `pickCommission` / `pickHeroForTeam` |
| `apply*` | state 変化を確定 (= 金銭/コミット) | `applyFactoryLvUp` |
| `find*` | condition で検索 | `findEmptyCraftSlot` / `findActiveHero` |
| `get*` / `set*` | accessor / mutator | `getActiveCraft(idx)` / `setActiveCraft(idx, ac)` |
| `tick*` | 毎 tick simulation | `tickActiveCraft(idx)` |
| `is*` / `can*` | bool 判定 | `isExtUnlocked` / `canSellExt` |
| `*Async` | 非同期 | `loadHeroesAsync` |

### 例外: legacy 呼称

旧コードに残っている命名 (= `craftIsBusy()` 等) は段階的にリネーム。 SPEC で議論。

## 2. ファイル分割

`js/main.js` が肥大化しがちなので **責務分割** を意識:

- `main.js` — bootstrap / state 定義 / onTick / view routing
- `factory-<feature>.js` — 単機能のロジック (= craft / quest / market / hero)
- `i18n.js` — 多言語
- `constants.js` — `ASSET_BASE` + URL builder
- `effects.js` — confetti / sprite float
- `ranking-client.js` — GAS 通信

新機能を追加するときは **既存ファイルを肥大化させずに新規モジュールを切る** か検討。

## 3. State 設計

- `state` は単一オブジェクト (= 全ゲーム状態がここに集約)
- `state.activeXXX` は単数 (= 旧設計のまま)、 並行スロットには `state.activeXXXExtra: [...]` を併記
- `state.pendingXXX` は modal 表示中の一時データ
- `state.lastXXXAt` は最終発火時刻 (= dedup 用)
- `state.monthlyEventsFired` は `Set` (= "{year}-{eventKey}" でユニーク化)

派生プロジェクトでも、 これらの命名を踏襲してください。

## 4. Pause/Resume 不変条件

詳細: `docs/patterns/04-time-and-modals.md`

要約:
- `pauseTime()` / `resumeTime()` は対で呼ぶ
- modal 開閉 (= open/close 関数) で必ずペア
- `maiSays/maiSaysSequence` は 「既に paused なら自前 pause を skip」 (= 二重 pause 防止)
- onClose チェーンは「次の modal が pauseTime する」 か「resume してから次へ」 を統一

## 5. i18n 規則

詳細: `docs/patterns/03-i18n-and-help.md`

要約:
- すべての UI 文字列は `data/i18n/ui.json` に登録
- HTML 中は `data-i18n="key"` 属性で参照
- runtime 文字列は `t("key")` または `ti18n("key", "fallback")`
- runtime 置換は `{var}` を `replace` で
- Object 形式 (`{"ja":"..","en":".."}`) と単純文字列の両方サポート

## 6. CSS 階層

詳細: `docs/patterns/02-screen-structure.md` の z-index 表

要約:
- 0-4: 背景・マップ
- 5-8: スプライト・カード
- 10-90: 通常 UI (button / panel)
- 100: floating popup
- 120: モーダル背景
- 150: カットイン
- 200: タイトル
- 320: 緊急 popup (salary report 等)
- 1000: 起動画面 / loading
- 1100+: ランキング (= タイトルより上に)

## 7. PR / コミット

詳細: `docs/process/GIT_WORKFLOW.md`

要約:
- ブランチ: `feature/<topic>` / `fix/<topic>` / `docs/<topic>` / `chore/<topic>`
- コミット: Conventional Commits + Phase ラベル + Co-Author
- PR タイトル: 短く具体的 (= "feat: 月次年俸 popup")
- PR body: Summary / Test plan / 関連 SPEC リンク

## 8. テスト

詳細: `docs/testing/TESTING_STRATEGY.md`

- 純関数 (= 戦闘計算、 報酬抽選) は **seed 乱数で決定論的シミュレータ** に切り出す
- UI / フローは **手動 QA チェックリスト** を PR の Test plan に書く
- バランス調整は `tools/sim/*.mjs` で N=1000 等の試行を回す

## 9. アセット参照

- 画像 / 音声 / フォント は `js/constants.js` の `ASSET_BASE` 経由
- リポジトリ内には **小さな placeholder** のみコミット (= og-image.png 等)
- 大量のアセット (= 数百画像) は外部 CDN (= GitHub raw) を参照

## 10. 並行・並列スロット設計

詳細: `docs/patterns/06-state-and-data.md`

旧コードの `state.activeCraft` (= 単数) を temporarily 残しつつ、 新機能で `state.activeCraftExtra: [obj|null, obj|null]` を併設する **slot accessor パターン** を採用。

```js
function getActiveCraft(idx) {
  if (idx === 0) return state.activeCraft || null;
  return state.activeCraftExtra?.[idx - 1] || null;
}
function forEachCraftSlot(fn) {
  fn(0, state.activeCraft);
  state.activeCraftExtra?.forEach((ac, i) => fn(i + 1, ac));
}
```

これで既存コード (= 旧 `state.activeCraft` を直接参照) との互換性を保ちながら段階移行できる。

## 11. 月次イベント

詳細: `docs/patterns/06-state-and-data.md`

```js
state.monthlyEventsFired // Set<"{year}-{eventKey}">

function checkMonthlyEvents() {
  if (state.month === 4 && state.week === 1) {
    const key = `${state.year}-salary`;
    if (!state.monthlyEventsFired.has(key)) {
      state.monthlyEventsFired.add(key);
      triggerAnnualSalary();
    }
  }
}
```

## 12. ランキング送信規約

詳細: `docs/patterns/07-ranking-integration.md`

- payload に `version` を含める (= 旧バージョンとの混在を識別)
- `timestamp` は ISO 8601
- POST body は `text/plain` (= CORS preflight 回避)
- localStorage に `<prefix>.rankingApiUrl` で URL 上書き可能

## 13. ドキュメントの書き方

- すべての .md は **見出しで階層化**
- コード例は ` ``` ` で囲む + 言語指定
- 表で対比 (= Before/After / 旧/新)
- 図表は ASCII art (= mermaid は補助的に)
- ユーザー向け文言は **平易な日本語**、 技術解説は適切に絵文字 (🐛 🆕 ✅ 等)

## 14. 例外対応

ここに書いていないことが起きたら:

1. CLAUDE.md と AGENTS.md を再読
2. 既存 SPEC を grep
3. `docs/patterns/` を流し読み
4. それでも判断つかなければユーザーに相談 (= 一方的に決めない)
