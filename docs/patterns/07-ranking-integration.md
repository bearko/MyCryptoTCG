# Pattern 07 — ランキング統合 (Google Apps Script)

## 1. 全体像

```
[Browser (= player)] ── POST/GET ──> [GAS Web App] ── append/read ──> [Google Sheet]
```

- GAS Web App = Spreadsheet 横の Apps Script で `doPost` / `doGet` を実装
- クライアント = `js/ranking-client.js` で fetch
- URL は base64 で難読化して埋め込み + localStorage で上書き可能

## 2. クライアント実装

`js/ranking-client.js`:

```js
const LS_API_URL = "<prefix>.rankingApiUrl";
const LS_PLAYER_NAME = "<prefix>.playerName";

const _DEFAULT_API_URL_ENC = "";   // ← deploy 後に btoa(...) で埋める

function _decodeDefault() {
  try {
    if (!_DEFAULT_API_URL_ENC) return null;
    return typeof atob === "function" ? atob(_DEFAULT_API_URL_ENC) : null;
  } catch (e) { return null; }
}

export function getRankingApiUrl() {
  try {
    const v = localStorage.getItem(LS_API_URL);
    if (v && v.trim()) return v.trim();   // localStorage 優先
  } catch (e) {}
  const def = _decodeDefault();           // 既定 URL 2 次
  return (def && def.trim()) ? def.trim() : null;
}

export function setRankingApiUrl(url) {
  try {
    if (!url || !url.trim()) localStorage.removeItem(LS_API_URL);
    else localStorage.setItem(LS_API_URL, url.trim());
  } catch (e) {}
}

export function getPlayerName() {
  try { return localStorage.getItem(LS_PLAYER_NAME) || ""; }
  catch (e) { return ""; }
}

export function setPlayerName(name) {
  try {
    const trimmed = (name || "").trim().slice(0, 30);
    if (!trimmed) localStorage.removeItem(LS_PLAYER_NAME);
    else localStorage.setItem(LS_PLAYER_NAME, trimmed);
  } catch (e) {}
}

export async function submitScore(payload) {
  const url = getRankingApiUrl();
  if (!url) return { ok: false, error: "ランキング API URL が未設定" };
  try {
    const body = { ...payload, timestamp: new Date().toISOString() };
    const res = await fetch(url, {
      method: "POST",
      mode: "cors",
      cache: "no-cache",
      headers: { "Content-Type": "text/plain;charset=utf-8" },  // CORS preflight 回避
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json().catch(() => ({}));
    return { ok: !!data.ok, error: data.error };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

export async function fetchRanking(opts = {}) {
  const url = getRankingApiUrl();
  if (!url) return { ok: false, error: "ランキング API URL が未設定" };
  try {
    const params = new URLSearchParams();
    if (opts.regulation) params.set("regulation", opts.regulation);
    if (opts.version)    params.set("version", opts.version);
    if (opts.limit)      params.set("limit", String(opts.limit));
    const fullUrl = params.toString() ? `${url}?${params}` : url;
    const res = await fetch(fullUrl, { method: "GET", mode: "cors", cache: "no-cache" });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json().catch(() => ({}));
    return { ok: !!data.ok, ranking: data.ranking || [], error: data.error };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}
```

## 3. GAS スクリプト

### ⚠ Numeric Separator 禁止

GAS V8 ランタイムは ES2021 numeric separator (`4_800_000`) を **受け付けない**。 `4800000` のように underscore なしで書くこと。

### スクリプト本体

```javascript
const SHEET_NAME = "ranking";
const HEADERS = [
  "timestamp", "playerName", "score",
  // ↓ 各プロジェクトで追加カラム
  "version",
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
      // ↓ 各プロジェクトで追加カラム
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
    if (versionFilter) filtered = filtered.filter(r => String(r[/* version idx */]) === versionFilter);
    filtered.sort((a, b) => Number(b[2]) - Number(a[2]));   // by score desc
    const limit = Math.min(Number(e.parameter.limit) || 50, 200);
    const top = filtered.slice(0, limit).map((r, idx) => ({
      rank: idx + 1,
      timestamp: r[0],
      playerName: String(r[1]),
      score: Number(r[2]),
      // ... 追加カラム ...
      version: String(r[/* version idx */]),
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

// ダミーデータ投入 (任意、 開発用)
function seedDummyData() {
  const sheet = _ensureSheet();
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const samples = [
    ["MasterPlayer", 10000, "1.0"],
    ["RookiePlayer", 5000, "1.0"],
    // ...
  ];
  samples.forEach((s, i) => {
    const ts = new Date(now - (samples.length - i) * day);
    sheet.appendRow([ts, s[0], s[1], s[2]]);
  });
  Logger.log("Seeded " + samples.length + " rows.");
}
```

## 4. デプロイ手順

詳細: `docs/setup/google-apps-script.md`

要約:
1. Spreadsheet 新規作成 → タブ名を `ranking` に
2. 「拡張機能」→「Apps Script」 でスクリプト貼り付け
3. デプロイ → ウェブアプリ → 種類「ウェブアプリ」 / 実行: 自分 / アクセス: **全員**
4. 表示される URL をコピー
5. `btoa("https://script.google.com/macros/s/.../exec")` で base64 化
6. `_DEFAULT_API_URL_ENC` に貼り付けて commit

## 5. URL 設定 UI

ランキング画面に「上級設定」 セクションを追加:

```html
<details class="ranking-viewer__settings">
  <summary>上級設定: 別のランキングサーバーを使う</summary>
  <p>独自に GAS をデプロイした場合のみ利用してください。</p>
  <label>
    <span>Apps Script URL</span>
    <input type="url" id="rankingApiUrlInput"
           placeholder="https://script.google.com/macros/s/.../exec" />
  </label>
  <button id="rankingApiUrlSaveBtn">保存</button>
</details>
```

## 6. ランキング viewer モーダル

```js
async function refreshRanking() {
  const list = $("#rankingList");
  list.innerHTML = "<li>取得中…</li>";
  const result = await fetchRanking({ limit: 50, version: APP_VERSION });
  if (!result.ok) {
    list.innerHTML = `<li>取得失敗: ${result.error}</li>`;
    return;
  }
  if (result.ranking.length === 0) {
    list.innerHTML = "<li>まだランキング登録がありません</li>";
    return;
  }
  list.innerHTML = result.ranking.map(r => `
    <li data-rank="${r.rank}">
      <span class="ranking-rank">#${r.rank}</span>
      <span class="ranking-name">${escapeHtml(r.playerName)}</span>
      <strong class="ranking-score">${r.score.toLocaleString()}</strong>
    </li>
  `).join("");
}
```

## 7. 1〜3 位ハイライト CSS

```css
.ranking-list li[data-rank="1"] {
  background: linear-gradient(90deg, rgba(255,215,0,.15), transparent);
  border-left: 3px solid gold;
}
.ranking-list li[data-rank="2"] {
  background: linear-gradient(90deg, rgba(192,192,192,.15), transparent);
  border-left: 3px solid silver;
}
.ranking-list li[data-rank="3"] {
  background: linear-gradient(90deg, rgba(205,127,50,.15), transparent);
  border-left: 3px solid #cd7f32;
}
```

## 8. テストケース

- [ ] localStorage に URL を保存 → 別ブラウザで開いて反映されるか
- [ ] 既定 URL のみで送信できるか (= localStorage 空)
- [ ] 送信失敗時に「ランキング API URL が未設定」 が表示されるか
- [ ] 上位 50 件が score 降順で並ぶか
- [ ] version フィルタが効くか
- [ ] 同じプレイヤーが複数回送ったとき、 すべて記録されるか (= 履歴重視)
- [ ] GAS 側で seedDummyData が numeric separator エラー無く実行できるか
- [ ] 30 文字超のプレイヤー名が trim されるか
