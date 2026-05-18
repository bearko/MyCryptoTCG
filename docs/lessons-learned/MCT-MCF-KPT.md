# MCT + MCF 2 作 KPT 振り返り

bearko さんと Claude Code の二人三脚で開発した MyCryptoTactics と MyCryptoFactory の 2 作を踏まえた振り返り。
このテンプレート (`mycryptotemplate`) の発端となった文書。

## ✅ Keep — 続けたい良かった点

### K1. Spec → Phase → PR の三段階分割

- 大きな機能 (= MCF クラフト並列スロット, 給与報告書 popup) を **Phase 単位の小型 PR** に切れていた
- 1 PR = 1 論理変更 を貫けたため、 レビュー / revert / cherry-pick が容易
- 「Conventional Commits + Phase tag」 として `docs/process/GIT_WORKFLOW.md` に永続化

### K2. 「動作確認 → merge → 次へ」 のリズム

- bearko さんが **Vercel preview を必ず開いて smoke test** してから merge していた
- AI 任せの auto-merge を許さない PR-only HITL 方針が、 prod 障害を実質 0 に保てた要因
- AGENTS.md の HITL escalation rules に反映

### K3. 観察 → 仕様化 → 実装 のフィードバックループが速い

- 「給与をマイが 1 つずつ説明するの面倒」 → 同日中に SPEC + 実装 + merge
- ユーザー (= bearko さん本人) が UX デザイナー兼ディレクターとして即時 feedback を返す体制が AI ペアプロと噛み合っていた
- DEVELOPMENT_CHARTER.md の "観察駆動開発" として残した

### K4. 双子プロジェクトでの知見転用

- MCF Phase 1D-47 で発見した maiSays double-pause leak が、 後の MCT 戦闘 modal でも同じ罠を回避できた
- 共通パターンを「テンプレ化したい」 という発想自体が高解像度
- `docs/patterns/04-time-and-modals.md` に full document として保存

### K5. 命名規則の一貫性

- `trigger* / open* / close* / render* / pick* / apply* / find* / get* / set* / tick* / is*` の動詞 prefix が大きくブレなかった
- 後から関数を grep する時の発見性が高い
- `docs/patterns/08-dev-conventions.md` に法則化

---

## ⚠ Problem — 改善すべきだった点

### P1. Skill / Sub-agent の活用不足

- `Explore` agent を「ファイル探索」 で使うべき場面で Glob/Grep を直接連発していた
- `Plan` agent を「設計だけ先に固める」 場面で使えていなかった
- `/loop` `/schedule` skill の存在を後半まで使い切れていなかった (= バランス調整 sim を手動で何度も回していた)
- 結果: **同じ失敗を繰り返す → context が肥大化 → コンパクト発生**

### P2. Context の浪費 (= コンパクト処理頻発の根因)

具体的な無駄:
- 古い実装ファイルを **何度も Read し直していた** (= キャッシュせずその場で記憶頼り)
- Charter / Spec を Claude が冒頭で読まないまま実装に入り、 後で「あ、 規約違反でした」 → 修正 PR
- ログ / console 出力を全文 paste で会話に流していた (= 200+ 行)
- 大量ファイル列挙を `ls -R` で取って context に詰めていた

### P3. テストケースが「PR 後付け」 だった

- 「Phase X 完了 → bearko さんが手動 QA → バグ発見 → 翌 PR で修正」 のパターン頻発
- Phase 内で **作るべきテストケースを SPEC 段階で列挙** していれば 50% は事前に防げた
- 例: `tryAutoRedeployQuest` の slot 0 限定バグ (PR #88) は、 並列スロット導入時に「全 slot に対して再配置できるか」 を spec 段階で書けば未然に防げた

### P4. デバッグフラグの半永久残置

- `console.log("[pause] +1 → ...")` 等が main に残ったまま prod に流れていた回数が複数
- 「DEBUG_PAUSE フラグで囲む」 ルールを後付けしたが、 **commit 前 self-review チェックリスト** に組み込めていなかった

### P5. 重複ロジックの統合タイミング

- `state.activeCraft` (slot 0) と `state.activeCraftExtra` (slot 1+) の二重 API が長期間残った
- 早めに `getActiveCraft(idx)` accessor 1 本に統合すべきだったが、 後方互換を理由に放置 → 都度バグの温床

### P6. アセット URL ハードコードの分散

- `https://raw.githubusercontent.com/...` が 5+ ファイルに直書きされていた時期あり
- constants.js の `ASSET_BASE` 一本化が遅かった

---

## 🚀 Try — 次から試したい改善

### T1. Sub-agent を「最初に呼ぶ」 を default にする

| 場面 | 使うべき agent |
|---|---|
| 「この関数どこで定義されてる?」 | **Explore** (= Glob/Grep を自分で打たない) |
| 「この機能どう実装する?」 | **Plan** (= 設計を先に固める) |
| 「Claude Code の skill / hook どうやる?」 | **claude-code-guide** |
| 「複数の独立調査を並行させたい」 | **general-purpose × 並列起動** |

→ AGENTS.md にケース別ガイドとして反映

### T2. Spec 駆動 + テストケース先行 の徹底

- SPEC-NNN を書く時点で `## 7. テストケース` セクションを必ず埋める
- Phase 着手前に bearko さんが「このケースが通れば OK」 と確認 → 実装後の手動 QA がチェックリスト化される
- SPEC_DRIVEN_DEVELOPMENT.md にテンプレートとして強制

### T3. Skill `/loop` と `/schedule` の積極活用

- 数値バランス調整は `/loop` で sim 自動回し
- 定期 health check / smoke test は `/schedule` で cloud 化
- tools/sim/BALANCE_LOOP.md に呼び出しサンプル記載済み

### T4. Context 節約パターン

具体的な改善:
- ファイル全文を Read せず、 必要なら `offset/limit` で部分読み
- 探索は **必ず Explore agent** に投げる (= 結果サマリだけ返ってくる)
- 大量ログは `head_limit` / `pattern` で絞ってから取る
- 200 行超の paste はファイルに書き出して URL 参照

### T5. PR テンプレートで self-review 強制

PR テンプレ `Test plan` の最後に追加:
- [ ] `console.log` / TODO 残しがない
- [ ] DEBUG_* フラグが OFF
- [ ] 新規 magic number は const 化済み
- [ ] CLAUDE.md の命名規則に従っている

→ `.github/PULL_REQUEST_TEMPLATE.md` に組み込み済み

### T6. 観察 → 仕様化 の形式化

bearko さんの即時 feedback (= 「面倒」 「頭に入ってこない」) を Spec の `## 1. 背景` の引用ブロックに **そのまま貼る** 規約を作る:

```markdown
## 1. 背景
> 給与をマイが 1 つ 1 つ説明するの面倒 + 頭に入ってこない (bearko, 2026-XX-XX)
```

後から「なぜこの仕様か」 が一発で分かる + AI が誤読しにくい。

### T7. Sub-agent への delegation 基準

1 タスクが以下のどれかなら必ず agent 化:
- 5 ファイル以上を読む必要がある
- 結果を要約だけ知りたい
- 並列に走らせたい (= 複数領域の調査)
- 自分の context を温存したい

→ AGENTS.md に「いつ delegate するか」 セクションを追記

### T8. テンプレート由来の「再起動コスト」 を測る

mycryptotemplate を使った次回プロジェクトで:
- Day 1 で「タイトル + i18n + 時間制御」 が動くか
- Day 3 までに最初のゲームメカニクスが入るか
- これまで 1 週間かかっていたものを **2 日で同等地点** に到達できるかを測定

効果が薄ければテンプレを再改訂。

---

## 総括

bearko さんの 2 作は **「観察 → 仕様化 → 小刻み PR」 のリズム** が極めて優れていた。一方で **AI 側 (= Claude) が context 効率と sub-agent 活用で機械的に貢献できる余地** がまだ大きく、これがコンパクト頻発と工数増大の根本原因。

mycryptotemplate には以下を仕込んだので、次のプロジェクトでは **Day 1 から正しい型で走り出せる** はず:

- Skills / Sub-agent 推奨カタログ (AGENTS.md)
- Context 節約のための pattern docs
- PR / Spec テンプレートで self-review 強制
- Phase 1D-47 のような特殊事例の永続記録 (= 同じ罠を踏まない)

次回プロジェクトで「Day 1 でどこまで進めたか」 を測定すれば、テンプレートの実効性が定量的に評価できる。
