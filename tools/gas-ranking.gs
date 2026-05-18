// ============================================================
// gas-ranking.gs — MyCryptoSurvivor ranking endpoint (Google Apps Script Web App)
// ============================================================
//
// 1) Google Spreadsheet を新規作成 (= 名前は何でも OK、 例: "MyCryptoSurvivor Ranking")
// 2) [拡張機能] → [Apps Script] でこのファイル全文を貼り付け、 保存
// 3) [デプロイ] → [新しいデプロイ] → [種類: ウェブアプリ]
//      - 説明: "MCS ranking v1"
//      - 次のユーザーとして実行: 自分
//      - アクセスできるユーザー: **全員 (= 匿名アクセス許可)**
// 4) 「ウェブアプリの URL」 をコピー → ゲーム側で localStorage.setItem("mcs.rankingApiUrl", URL)
//    あるいは js/ranking-client.js の `_DEFAULT_API_URL_ENC` に btoa(URL) をセットしてコミット
// 5) ブラウザで {URL}?limit=5 を開いて `{ "ok": true, "ranking": [] }` が返れば OK
//
// ⚠ 「全員」 アクセスにすると **誰でも GET / POST 可能** になる。 個人プロジェクトの想定。
// ⚠ 不正対策が必要なら GAS 側で score 上限 / IP rate limit を別途追加。

const SHEET_NAME = "ranking";
// SPEC-037: regulation + regulationMul を末尾に追加
const HEADERS = [
  "timestamp", "playerName", "score",
  "level", "kills", "hero", "faction", "version", "elapsedSec",
  "regulation", "regulationMul",
];

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || "{}");
    if (!body || typeof body.score !== "number") {
      return _json({ ok: false, error: "invalid payload" });
    }
    const sheet = _getOrCreateSheet();
    const row = HEADERS.map(h => h === "timestamp" ? (body.timestamp || new Date().toISOString()) : (body[h] != null ? body[h] : ""));
    sheet.appendRow(row);
    return _json({ ok: true });
  } catch (err) {
    return _json({ ok: false, error: String(err && err.message || err) });
  }
}

function doGet(e) {
  try {
    const params  = (e && e.parameter) || {};
    const limit   = Math.min(parseInt(params.limit || "20", 10) || 20, 100);
    const version = params.version || null;
    const sheet   = _getOrCreateSheet();
    const data    = sheet.getDataRange().getValues();
    if (data.length < 2) return _json({ ok: true, ranking: [] });

    // ヘッダー行から index map (= 並び替えがあっても堅牢に)
    const idx = {};
    const headerRow = data[0];
    HEADERS.forEach(h => {
      const i = headerRow.indexOf(h);
      idx[h] = i >= 0 ? i : -1;
    });

    const regulation = params.regulation || null;   // SPEC-037: NORMAL / ABSOLUTE で絞込
    const rows = data.slice(1)
      .map(r => ({
        timestamp:    _str(r[idx.timestamp]),
        playerName:   _str(r[idx.playerName]),
        score:        Number(r[idx.score]) || 0,
        level:        Number(r[idx.level]) || 0,
        kills:        Number(r[idx.kills]) || 0,
        hero:         _str(r[idx.hero]),
        faction:      _str(r[idx.faction]),
        version:      _str(r[idx.version]),
        elapsedSec:   Number(r[idx.elapsedSec]) || 0,
        regulation:   _str(r[idx.regulation]) || "NORMAL",   // SPEC-037
        regulationMul: Number(r[idx.regulationMul]) || 1,
      }))
      .filter(r => !version    || r.version    === version)
      .filter(r => !regulation || r.regulation === regulation)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return _json({ ok: true, ranking: rows });
  } catch (err) {
    return _json({ ok: false, error: String(err && err.message || err), ranking: [] });
  }
}

function _getOrCreateSheet() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(HEADERS);
  } else if (sh.getLastRow() === 0) {
    sh.appendRow(HEADERS);
  }
  return sh;
}

function _json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function _str(v) { return v == null ? "" : String(v); }

// ============================================================
// SPEC-035: テスト用サンプルデータ投入 (= GAS エディタから手動実行)
// ============================================================
// 使い方:
//   1) Apps Script エディタの関数選択ドロップダウンで `seedSampleData` を選ぶ
//   2) 実行ボタン → 初回は権限承認ダイアログ
//   3) Spreadsheet を見るとヘッダー行 + 12 件のダミーデータが入る
//
//   `seedSampleData()`     = ranking シートを **完全リセット** してヘッダー + 12 件投入 (= 推奨)
//   `appendSampleData()`   = 既存行は残して 12 件 **追記**
//   `clearAllRankings()`   = ヘッダーは残して全データを削除 (= 開発時のクリーンアップ用)

const _SAMPLE_HEROES = [
  { name: "コナン・ドイル",  faction: "GENBU"  },
  { name: "甲斐姫",          faction: "SUZAKU" },
  { name: "シートン",        faction: "SEIRYU" },
  { name: "ピタゴラス",      faction: "BYAKKO" },
  { name: "ライト兄弟",      faction: "GENBU"  },
  { name: "スパルタクス",    faction: "SUZAKU" },
  { name: "グリム兄弟",      faction: "BYAKKO" },
  { name: "孫子",            faction: "SEIRYU" },
  { name: "石田三成",        faction: "KOURYU" },
  { name: "許褚",            faction: "SUZAKU" },
];

const _SAMPLE_PLAYERS = [
  "alice", "ボブ", "carol", "デイブ", "Eve",
  "フランク", "grace", "ハイディ", "ivan", "ジュリア",
  "kenji", "リン",
];

function seedSampleData() {
  const sh = _getOrCreateSheet();
  // 1 行目 (= ヘッダー) を残してそれ以降をクリア
  if (sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).clearContent();
  }
  _appendSampleRows(sh, _SAMPLE_PLAYERS.length);
  return _SAMPLE_PLAYERS.length;
}

function appendSampleData() {
  const sh = _getOrCreateSheet();
  _appendSampleRows(sh, _SAMPLE_PLAYERS.length);
  return _SAMPLE_PLAYERS.length;
}

function clearAllRankings() {
  const sh = _getOrCreateSheet();
  if (sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).clearContent();
  }
  return true;
}

function _appendSampleRows(sh, n) {
  const now = new Date();
  const rows = [];
  for (let i = 0; i < n; i++) {
    const player = _SAMPLE_PLAYERS[i % _SAMPLE_PLAYERS.length];
    const hero   = _SAMPLE_HEROES[i % _SAMPLE_HEROES.length];
    // score: 30000 ~ 8000 でばらけさせる (= 1 位を高めに)
    const score      = Math.round(30000 - i * (22000 / Math.max(1, n - 1)) + Math.random() * 1500);
    const level      = Math.max(1,  30 - Math.floor(i * 1.6) + Math.floor(Math.random() * 4));
    const kills      = Math.max(20, 600 - i * 38 + Math.floor(Math.random() * 60));
    const elapsedSec = Math.max(180, 280 + Math.floor(Math.random() * 320));
    // timestamp は数日前から少しずつばらつかせる (= ranking 一覧でリアルに見える)
    const ts = new Date(now.getTime() - i * 1000 * 60 * 60 * 7).toISOString();
    // SPEC-037: 偶数 index は NORMAL、 奇数は ABSOLUTE で 1.0..2.0 のランダム倍率
    const isAbs = (i % 2 === 1);
    const regulation    = isAbs ? "ABSOLUTE" : "NORMAL";
    const regulationMul = isAbs ? Math.round((1.0 + Math.random()) * 100) / 100 : 1.0;
    rows.push([
      ts, player, score, level, kills,
      hero.name, hero.faction, "0.1.0", elapsedSec,
      regulation, regulationMul,
    ]);
  }
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, HEADERS.length).setValues(rows);
}
