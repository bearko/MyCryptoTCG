# 新規プロジェクト起ち上げ手順

このテンプレートをコピーして新しいゲームプロジェクトを始める手順。

## 1. リポジトリ作成

### 1.1 GitHub テンプレートとして使う

`bearko/mycryptotemplate` を「Use this template」 → `bearko/mycryptoxxx` を作成。

または:

```bash
git clone https://github.com/bearko/mycryptotemplate.git mycryptoxxx
cd mycryptoxxx
rm -rf .git
git init
git add .
git commit -m "chore: initial commit from mycryptotemplate"
gh repo create bearko/mycryptoxxx --public --source=. --remote=origin --push
```

## 2. localStorage prefix の置換

各プロジェクトで唯一無二の prefix を決める (= `mct`, `mcf`, `mcp` 等)。

```bash
# 全ファイル一括置換 (= macOS / Linux)
grep -rln '<prefix>' . | xargs sed -i '' 's/<prefix>/mcq/g'

# Windows PowerShell
Get-ChildItem -Recurse -File | ForEach-Object {
  (Get-Content $_.FullName) -replace '<prefix>', 'mcq' | Set-Content $_.FullName
}
```

対象キー:
- `<prefix>.lang` → `mcq.lang`
- `<prefix>.rankingApiUrl` → `mcq.rankingApiUrl`
- `<prefix>.playerName` → `mcq.playerName`
- `<prefix>.save.v1` → `mcq.save.v1`

## 3. プロジェクト名 / メタの置換

| 場所 | 置換前 | 置換後 (例) |
|---|---|---|
| `index.html` `<title>` | `<ProjectName>` | `MyCryptoQuest` |
| `index.html` OGP | `<og:title>` | `MyCryptoQuest` |
| `package.json` (= ある場合) | `name` | `mycryptoquest` |
| `README.md` | テンプレート名 | プロジェクト名 |
| `og-image.png` | プレースホルダ | プロジェクト用 |

## 4. アセット CDN の設定

`js/constants.js`:

```js
// Before
export const ASSET_BASE = "https://raw.githubusercontent.com/<user>/<asset-repo>/main/";

// After
export const ASSET_BASE = "https://raw.githubusercontent.com/bearko/mycryptoquest-assets/main/";
```

別リポジトリでアセットを管理する場合:
```bash
gh repo create bearko/mycryptoquest-assets --public
```

または、 同リポジトリの `assets/` で済ませる場合:
```js
export const ASSET_BASE = "./assets/";
```

## 5. i18n の初期化

`data/i18n/ui.json` のサンプル:

```json
{
  "title.press": { "ja": "Press to Start", "en": "Press to Start" },
  "btn.close":   { "ja": "閉じる",          "en": "Close" }
}
```

## 6. Charter 3 種を埋める

```
docs/charters/PROJECT_CHARTER.md   ← ゲームの目的・対象ユーザー・成功指標
docs/charters/DEVELOPMENT_CHARTER.md ← 命名規則・PR ルール (= テンプレート流用 OK)
docs/charters/DESIGN_CHARTER.md   ← 色・フォント・トーン
```

特に Project Charter は最初に書く (= ぶれない軸を作る)。

## 7. 最初の Spec を書く

```
specs/
  SPEC-001-project-setup.md
```

テンプレートは `docs/process/SPEC_DRIVEN_DEVELOPMENT.md` 参照。

## 8. Vercel 連携

```bash
vercel link
vercel deploy --prod    # 初回 prod デプロイ
```

`vercel.json` (= 必要なら):
```json
{
  "redirects": [
    { "source": "/", "destination": "/index.html" }
  ]
}
```

## 9. GitHub Actions / Branch protection (= 任意)

```bash
# main / prod を保護
gh api repos/bearko/mycryptoquest/branches/main/protection -X PUT -f ...
```

または GitHub UI で:
- main / prod に直接 push 禁止
- PR レビュー必須
- conversation resolution 必須

## 10. ランキング GAS 設定 (= 必要な場合)

`docs/setup/google-apps-script.md` を参照。 流れ:

1. Spreadsheet 作成 → ranking タブ
2. Apps Script で コピペ → デプロイ
3. URL を base64 化 → `js/ranking-client.js` の `_DEFAULT_API_URL_ENC` に貼る

## 11. 動作確認チェックリスト

- [ ] `index.html` をブラウザで開いて表示される
- [ ] Console に致命的エラーがない
- [ ] 言語トグルが動く (= 既定 ja → en)
- [ ] localStorage に prefix が正しく保存される
- [ ] Vercel preview URL が動く
- [ ] mobile (= Chrome DevTools) で破綻しない

## 12. 起ち上げ完了

ここまでで「テンプレート由来のひな形」 が新リポジトリで動く状態に。 以降は SPEC-002 以降でゲーム機能を一個ずつ刻む。

### 推奨初期 SPEC 順

```
SPEC-001: project-setup            ← 完了済み
SPEC-002: title-screen             ← タイトル + 言語トグル + Press Start
SPEC-003: home-screen              ← ヘッダー + ステージ
SPEC-004: state-and-time-loop      ← state / pauseFlags / onTick
SPEC-005: <最初のゲームメカニクス>   ← クラフト、戦闘、進行など
SPEC-006: <次のゲームメカニクス>
...
```

## 13. テンプレート更新の取り込み (= 任意)

テンプレート側で改善が入ったら:

```bash
git remote add template https://github.com/bearko/mycryptotemplate.git
git fetch template
git merge template/main --allow-unrelated-histories
# ... コンフリクト解消 ...
```

ただしテンプレートとプロジェクトは独立進化するので、 通常は cherry-pick で必要分のみ取り込む方が現実的。
