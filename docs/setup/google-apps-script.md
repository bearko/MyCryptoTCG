# Google Apps Script (= ランキング API) 設定手順

ゲーム結果を Google Spreadsheet に集約してランキング表示する仕組み。

## 1. 全体像

```
[Browser] ──POST──> [GAS Web App] ──append──> [Google Sheet]
[Browser] ──GET───> [GAS Web App] ──read─────> [Google Sheet]
```

## 2. Spreadsheet 作成

1. drive.google.com で「新規」 → 「Google Spreadsheet」
2. 名前を `<projectname>-ranking` に
3. 1 つ目のシート名を `ranking` に変更

## 3. Apps Script 作成

1. Spreadsheet で「拡張機能」 → 「Apps Script」
2. デフォルトの `Code.gs` を以下で置き換え (= `docs/patterns/07-ranking-integration.md` のスクリプト本体を参照)

### ⚠ 重要: Numeric Separator 禁止

GAS V8 ランタイムは ES2021 numeric separator を **受け付けない**:

```js
// NG (= SyntaxError)
const MS = 4_800_000;

// OK
const MS = 4800000;
```

`heroes.json` 等のデータも GAS で扱う場合は同様に注意。

### スクリプト本体 (例)

```javascript
const SHEET_NAME = "ranking";
const HEADERS = [
  "timestamp", "playerName", "score", "version",
];

function _ensureSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  const firstRow = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  const headerMissing = firstRow.every((v) => v === "" || v === null);
  if (headerMissing) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const sheet = _ensureSheet();
    sheet.appendRow([
      new Date(),
      String(data.playerName || "anonymous").substring(0, 30),
      Number(data.score) || 0,
      String(data.version || ""),
    ]);
    return ContentService
      .createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  try {
    const sheet = _ensureSheet();
    const allRows = sheet.getDataRange().getValues();
    const rows = allRows.length > 1 ? allRows.slice(1) : [];
    let filtered = rows;
    const versionFilter = e.parameter.version;
    if (versionFilter) filtered = filtered.filter(r => String(r[3]) === versionFilter);
    filtered.sort((a, b) => Number(b[2]) - Number(a[2]));
    const limit = Math.min(Number(e.parameter.limit) || 50, 200);
    const top = filtered.slice(0, limit).map((r, idx) => ({
      rank: idx + 1,
      timestamp: r[0],
      playerName: String(r[1]),
      score: Number(r[2]),
      version: String(r[3]),
    }));
    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, ranking: top }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
```

## 4. デプロイ

1. 右上「デプロイ」 → 「新しいデプロイ」
2. 種類: **ウェブアプリ**
3. 説明: `v1`
4. 実行: **自分**
5. アクセス: **全員** (= 重要、 Google 認証必要にすると CORS で失敗)
6. 「デプロイ」 → 権限承認
7. 表示される URL をコピー (= `https://script.google.com/macros/s/AKfy.../exec`)

## 5. URL を obfuscate して埋め込む

クライアントから直接 URL を露出すると:
- スクレイピング bot からの spam が来る
- フォークしたユーザーが無意識にこのランキングに送信してしまう

これを防ぐため base64 化して埋め込む。

### Browser Console で base64 化

```js
btoa("https://script.google.com/macros/s/AKfy.../exec")
// → "aHR0cHM6Ly9..."
```

### `js/ranking-client.js` に貼る

```js
const _DEFAULT_API_URL_ENC = "aHR0cHM6Ly9zY3JpcHQuZ29vZ2xlLmNvbS9tYWNyb3MvLi4uL2V4ZWM=";
```

## 6. 動作確認

1. デプロイ URL を Postman / curl で叩く:
```bash
curl "https://script.google.com/macros/s/.../exec?limit=10"
# → {"ok":true,"ranking":[]}
```

2. POST テスト:
```bash
curl -X POST "https://script.google.com/macros/s/.../exec" \
  -H "Content-Type: text/plain;charset=utf-8" \
  -d '{"playerName":"test","score":1000,"version":"1.0"}'
# → {"ok":true}
```

3. ブラウザで自分のゲームから送信できるか
4. Spreadsheet に行が追加されるか

## 7. ダミーデータ投入 (= 開発用)

GAS Editor で `seedDummyData` 関数を実行:

```javascript
function seedDummyData() {
  const sheet = _ensureSheet();
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const samples = [
    ["MasterPlayer", 10000, "1.0"],
    ["RookiePlayer", 5000, "1.0"],
    ["MidPlayer", 7500, "1.0"],
  ];
  samples.forEach((s, i) => {
    const ts = new Date(now - (samples.length - i) * day);
    sheet.appendRow([ts, s[0], s[1], s[2]]);
  });
  Logger.log("Seeded " + samples.length + " rows.");
}
```

実行ボタン押下 → 権限承認 → ログ確認。

## 8. version カラム追加 / マイグレーション

途中でカラムを追加した場合:

1. GAS の `HEADERS` 配列に追加
2. `appendRow` の引数に追加
3. `doGet` の出力に追加
4. 既存行は欠損 (= undefined) になるので、 client 側で `r.newField || ""` で吸収

## 9. CORS preflight 回避

```js
fetch(url, {
  method: "POST",
  headers: { "Content-Type": "text/plain;charset=utf-8" },  // ← 重要
  body: JSON.stringify(payload),
});
```

`application/json` にすると preflight (OPTIONS) が走るが、 GAS は OPTIONS をサポートしないので失敗する。 **必ず text/plain を指定**。

## 10. レート制限 / spam 対策 (= 任意)

GAS 側で IP / playerName で簡易チェック:

```javascript
function doPost(e) {
  const data = JSON.parse(e.postData.contents);
  
  // 1 分あたり 1 ユーザー 1 回まで
  const cache = CacheService.getScriptCache();
  const key = "rate_" + data.playerName;
  if (cache.get(key)) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: "rate-limited" }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  cache.put(key, "1", 60);   // 60 sec
  
  // ... append ...
}
```

## 11. 再デプロイのコツ

スクリプトを変更したら:

1. 「デプロイ」 → 「デプロイを管理」
2. 該当デプロイの編集アイコン
3. バージョン: 「新しいバージョン」 を選択
4. 説明: `v2`, `v3`...
5. URL は変わらない (= 既存クライアントは継続動作)

⚠ **新しいデプロイ** を作ると URL が変わる → クライアント側 `_DEFAULT_API_URL_ENC` の更新が必要 → なるべく 「デプロイの管理」 から既存を更新する。

## 12. トラブルシューティング

| 症状 | 原因 | 対策 |
|---|---|---|
| CORS エラー | アクセス権限が「全員」 でない | デプロイ設定見直し |
| 401 / 403 | 同上 + Google 認証要求 | 「全員」 に変更 |
| 「スクリプトが応答しません」 | GAS の 6 分制限超過 | バッチ処理を細分化 |
| OPTIONS で 405 | application/json で送ってる | text/plain に変更 |
| numeric separator エラー | `4_800_000` 記法 | underscore 削除 |
| 旧データ消える | デプロイで Spreadsheet が初期化される | スクリプトのみ変更で再デプロイ |
