# Git Workflow

## 1. ブランチ戦略

```
main         ← 開発ブランチ (= staging Vercel preview がここから生える)
prod         ← 本番ブランチ (= production deploy)
feat/*       ← 機能ブランチ
fix/*        ← バグ修正ブランチ
docs/*       ← ドキュメント修正ブランチ
refactor/*   ← リファクタブランチ
release/*    ← リリース準備ブランチ (= prod へ promote するとき)
```

## 2. 通常の流れ

```bash
# 1. main から feature ブランチを切る
git checkout main
git pull
git checkout -b feat/spec-006-phase-1d-42-parallel-slots

# 2. 実装 + commit
git add <files>
git commit -m "feat(spec-006): Phase 1D-42 — Add parallel slot accessors"

# 3. push + PR
git push -u origin feat/spec-006-phase-1d-42-parallel-slots
gh pr create --base main --title "[spec-006] feat: ..."

# 4. レビュー後 merge → ローカル cleanup
git checkout main
git pull
git branch -D feat/spec-006-phase-1d-42-parallel-slots
```

## 3. main → prod へのリリース

定期的に main の変更を prod に上げる:

```bash
git checkout prod
git pull
git merge main --ff-only       # ← fast-forward でマージ (= 履歴を直線に保つ)
git push origin prod
```

ff-only にできない場合 (= prod に直接 hotfix が入った場合) は merge commit を作る:

```bash
git merge main --no-ff -m "release: merge main into prod"
```

## 4. ホットフィックス (= prod の緊急修正)

```bash
git checkout prod
git pull
git checkout -b fix/prod-hotfix-XXX
# ... 修正 ...
git commit -m "fix: <description>"
git push -u origin fix/prod-hotfix-XXX
gh pr create --base prod --title "[hotfix] fix: ..."

# merge 後、 main にも反映
git checkout main
git pull
git merge prod --ff-only       # ← prod の hotfix を main にも持ち帰る
git push origin main
```

## 5. Conventional Commits

`<type>(<scope>): <subject>`

| type | 用途 |
|---|---|
| feat | 新機能 |
| fix | バグ修正 |
| refactor | 動作変更なしのリファクタ |
| docs | ドキュメント |
| style | フォーマット |
| test | テスト |
| chore | ビルド・依存関係 |
| perf | パフォーマンス |

scope = spec ID (= `spec-006`) や領域名 (= `craft`, `quest`)。

### Subject 文例

```
feat(spec-006): Phase 1D-42 — Add parallel craft slots
fix(spec-007): Quest "休憩して再出発" doesn't unlock heroes
docs: Update CLAUDE.md with naming conventions
refactor(craft): Extract craft logic to craft.js
chore: Bump @typescript/lib to latest
```

## 6. コミット粒度

### 6.1 1 コミット = 1 論理変更

```
✅ 良い:
  - feat: Add parallel slot accessors
  - feat: Wire parallel slots into onTick
  - feat: UI integration for slot 2/3

❌ 悪い:
  - feat: Add parallel slots + UI + bugfix + i18n  ← 1 コミットに詰めすぎ
```

### 6.2 commit 前の `git status` 習慣

```bash
git status            # untracked / modified を確認
git diff              # 内容を確認
git diff --staged     # ステージ済みを確認
git add <files>       # 必要なものだけ追加 (= git add -A は避ける)
git commit            # ← editor が開いて message を書く
```

## 7. PR の出し方

### 7.1 タイトル

```
[<scope>] <type>: <subject>
```

例:
```
[spec-006] feat: Phase 1D-42 — Add parallel craft slots
[spec-007] fix: Quest 休憩して再出発 doesn't unlock heroes
```

### 7.2 本文 (= テンプレートに従う)

`.github/PULL_REQUEST_TEMPLATE.md` が自動的に展開される。

### 7.3 base ブランチ

- 通常: `main`
- ホットフィックス: `prod`
- リリース: `main` → `prod`

## 8. レビュー → merge

### 8.1 セルフレビュー

PR を出した後、 自分で diff を読み返す:
- `console.log` 残しがないか
- TODO コメント残しがないか
- 不要な空行・空白がないか
- ファイル末尾に改行があるか

### 8.2 マージ方式

| 方式 | 用途 |
|---|---|
| Squash | 通常 (= 1 PR = 1 commit に圧縮) |
| Merge | 大型機能で履歴を残したい場合 |
| Rebase | 直線履歴を保ちたい場合 (= 慎重に) |

このテンプレートでは **Squash** を推奨。

### 8.3 merge 後

```bash
git checkout main
git pull                           # ← squash 済みの commit を取得
git branch -D <feature-branch>     # ← ローカル cleanup
git push origin --delete <feature-branch>  # ← remote cleanup (= GitHub UI で auto delete 設定でも可)
```

## 9. タグとリリース

```bash
# main → prod merge 後 (= 本番デプロイ後)
git checkout prod
git tag -a v0.3.0 -m "Release v0.3.0 — Add parallel slots, salary report popup"
git push origin v0.3.0
```

GitHub Releases で release notes を書く:
- 主な機能追加
- バグ修正
- 既知の問題
- 互換性メモ (= save data の breaking change がある場合)

## 10. .gitignore 必須エントリ

```
# Node (= 直接使ってないけど IDE が出す)
node_modules/
package-lock.json
yarn.lock

# IDE
.vscode/
.idea/
*.swp

# OS
.DS_Store
Thumbs.db

# ログ
*.log

# 一時ファイル
tmp/
.cache/
.tmp/

# 環境設定
.env
.env.local
```

## 11. 大型 refactor の進め方

```
PR 1: refactor(craft): Extract craft state to state-craft.js
PR 2: refactor(craft): Move craft handlers to handlers-craft.js
PR 3: refactor(craft): Final cleanup + remove old craft.js
```

各 PR は単独で動作確認可能 (= 中途半端な状態を main に入れない)。

## 12. 「壊れたら戻す」 戦略

`prod` は常に動く状態を保つ:

- merge 直後に Vercel staging URL で smoke test
- 数分しても問題が出なければ prod に promote
- prod でバグが出たら **即座に revert PR** を出す:

```bash
git revert <commit-sha>
git push
gh pr create --base prod --title "revert: <subject>"
```

## 13. AI ペアプロ用ルール (= Claude Code への指示)

`.claude/settings.json` で permission 制御:

```json
{
  "permissions": {
    "allow": [
      "Bash(git status)", "Bash(git diff*)", "Bash(git log*)",
      "Bash(git add*)", "Bash(git commit*)", "Bash(git push*)",
      "Bash(gh pr create*)", "Bash(gh pr view*)"
    ],
    "ask": [
      "Bash(git push --force*)",
      "Bash(git reset --hard*)",
      "Bash(git rebase*)"
    ]
  }
}
```

Claude には以下を厳守させる (= CLAUDE.md に記載):
- 破壊的操作 (= force push, hard reset) は事前に確認
- `git add -A` / `git add .` は使わない (= 必ず file 名指定)
- ユーザーが明示的に依頼するまで commit しない
- main / prod に直接 push しない (= 必ず feature ブランチ経由)
