# Ranking Backend Setup

派生プロジェクトでランキング機能を有効化するための手順。 **2 系統のバックエンド**
を提供しており、 用途に応じて選択する。 クライアント (`js/ranking-client.js`)
は **両方とも同じ API 契約** (= POST/GET + `{ok, ranking, error}`) を期待
するので、 サーバー側を差し替えても **コード変更なし** で動く。

特別な指示がない限り、 派生プロジェクトは **Backend B (= Upstash Redis +
Vercel Function)** を既定として実装すること。 Claude セッションでの実装方針
は `CLAUDE.md` 「ランキング機能の実装方針」 を参照。

## 0. バックエンドの選択肢

| 観点 | **Backend B** — Upstash Redis + Vercel Function | **Backend A** — GAS + Spreadsheet |
|---|---|---|
| デプロイ先 | Vercel Functions + Upstash (= 無料枠あり) | Google Apps Script (= 無料) |
| ストレージ | Upstash Redis (= Sorted Set) | Google Spreadsheet |
| 必要なアカウント | Vercel + Upstash (= Vercel Marketplace から一括取得可) | Google |
| デプロイ手順の重さ | git push 連携 (= Vercel が自動 deploy) | ノーコード寄り (= GAS エディタ + ブラウザ操作のみ) |
| 静的ホスティング純度 | `api/ranking.js` を 1 ファイル追加するが `package.json` 不要 | 純静的のまま (= フロントだけリポジトリ) |
| レイテンシ | ~ 数十ms (= Redis インメモリ) | ~ 数百ms (= GAS warm-up あり) |
| 管理 UI | Upstash console + Vercel logs | Spreadsheet を直接眺められる |
| 同時書き込み耐性 | ○ (= Redis ZADD はアトミック) | △ (= シート write contention) |
| 無料枠 | Upstash: 10k commands/day 程度 (= 個人ランキングなら十分) | 実質無制限 (= 個人用途) |
| **位置付け** | **(= テンプレート既定、 派生プロジェクトはまずこちらを検討)** | (= 代替、 GAS で完結したい場合) |

選び方の目安:
- **特別な理由がない限り → Backend B** (= Vercel ホストが多数派、 レイテンシ短、 同時書き込み強)
- **Vercel を使わない / GAS で完結したい / Spreadsheet で直接眺めたい / Vercel・Upstash アカウントを増やしたくない** → Backend A
- **両方の手順を読んでから判断したい** → 全章スキャン推奨

---

# Backend B — Upstash Redis + Vercel Function (= 既定)

Vercel に既にホストしているなら、 同じ Vercel project 内の **Serverless
Function** (`api/ranking.js`) でランキング API を立てるのがシームレス。
バックエンドストレージは **Upstash Redis** (= Sorted Set がランキングそのもの)
を使うと ZADD / ZREVRANGE が 1 コマンドで済むので実装が短い。

## 1. 全体構成

```
[ブラウザ]                          [Vercel Function]              [Upstash Redis]
js/ranking-client.js   ──POST──▶  /api/ranking (Node serverless)  ──ZADD──▶
                       ──GET───▶  /api/ranking?limit=20           ──ZREVRANGE──▶
                       ◀──JSON─                                   ◀─ member JSON list
```

- **フロント**: `js/ranking-client.js` 変更不要 (= `submitScore` / `fetchRanking`
  はそのまま使える、 API URL を変えるだけ)
- **API URL**: 同一オリジンの `/api/ranking` を localStorage または
  `_DEFAULT_API_URL_ENC` に入れる (= `btoa("/api/ranking")` = `"L2FwaS9yYW5raW5n"`)
- **サーバー**: `tools/vercel-ranking.js` を `api/ranking.js` にコピーすると
  Vercel が自動で serverless function として deploy
- **バックエンド**: Upstash Redis を **REST API 経由** で叩く (= `@upstash/redis`
  SDK は使わない、 純 `fetch` のみ → **`package.json` 不要**)
- **依存**: なし (= Node 18+ の標準 `fetch` と環境変数だけ)

## 2. デプロイ手順 (= 10 分)

### 2.1 Upstash Redis を作る

**(推奨) Vercel Marketplace 経由**:

1. Vercel ダッシュボード → 対象 project → **Storage** タブ
2. **Create Database** → **Marketplace Database Providers** → **Upstash for Redis**
3. プラン: **Free** (= 個人ランキング用途なら十分)
4. リージョン: ホストするユーザーに近いもの (= 日本ユーザーなら ap-northeast-1)
5. **Create** ボタン → Vercel project に **自動的に環境変数が注入** される
   (= `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`)

**(代替) Upstash 直接**:

1. <https://console.upstash.com/> でサインアップ → **Create Database**
2. 表示される `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` を控える
3. Vercel project の **Settings → Environment Variables** に手動登録

### 2.2 `api/ranking.js` を repo に追加

リポジトリ ルートに `api/` ディレクトリを作り、 `tools/vercel-ranking.js` を
**`api/ranking.js`** という名前でコピー (= ファイル名がそのまま URL path になる)。

```bash
mkdir -p api
cp tools/vercel-ranking.js api/ranking.js
git add api/ranking.js
git commit -m "feat(ranking): Enable Backend B (Upstash on Vercel)"
```

(= テンプレート自体には `api/ranking.js` を入れない。 派生プロジェクトで
コピーしないと Vercel が空 endpoint を露出してしまうため)

### 2.3 git push → Vercel が自動 deploy

Vercel project が repo を連携済みであれば、 push しただけで:

1. 静的フロントは従来通り CDN にデプロイ
2. `api/*.js` は **Node 18+ runtime の serverless function** として deploy
3. 環境変数 `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` は
   2.1 で自動 / 手動注入したものが function 起動時に注入される

### 2.4 動作確認

ブラウザで `https://<your-project>.vercel.app/api/ranking?limit=5` を開く →
`{"ok":true,"ranking":[]}` が返れば成功。

POST 動作は `curl` で:

```bash
curl -X POST https://<your-project>.vercel.app/api/ranking \
  -H "Content-Type: text/plain;charset=utf-8" \
  -d '{"playerName":"alice","score":12345,"version":"0.1.0","regulation":"NORMAL"}'
```

`{"ok":true}` が返ったら、 直後の GET で 1 件入っているはず。

### 2.5 ゲームに URL を設定 (= 詳細は 4 章)

同一オリジン (= フロントと Vercel Function が同じドメイン) なら相対パス
`"/api/ranking"` を使うのが最も簡単:

```js
localStorage.setItem("<prefix>.rankingApiUrl", "/api/ranking");
```

または `js/ranking-client.js` に `btoa("/api/ranking")` の結果を埋め込み:

```js
// js/ranking-client.js
const _DEFAULT_API_URL_ENC = "L2FwaS9yYW5raW5n";   // = "/api/ranking"
```

**クロスオリジン** (= フロントは GitHub Pages、 API だけ Vercel 等) の場合は
完全 URL `"https://<project>.vercel.app/api/ranking"` を使う。 Function 側で
`Access-Control-Allow-Origin: *` を返しているので CORS は通る。

3 通りの URL 配布パターン (localStorage / hash bootstrap / builtin) の詳細は
**4 章** を参照。

## 3. データ構造 (= Redis Sorted Set)

| Redis key | 型 | 内容 |
|---|---|---|
| `ranking:<version>:<regulation>` | Sorted Set | score 順のメンバー集合 (= 1 ラン 1 メンバー) |

- **score** (= Sorted Set の数値): そのまま整数スコア
- **member** (= Sorted Set のユニークキー): エントリ全体を JSON 化した文字列

メンバー JSON のフィールド:

```json
{
  "playerName": "bearko",
  "score": 12345,
  "level": 27,
  "kills": 412,
  "hero": "コナン・ドイル",
  "faction": "SEIRYU",
  "version": "0.1.0",
  "elapsedSec": 412,
  "regulation": "NORMAL",
  "regulationMul": 1.0,
  "timestamp": "2026-05-10T12:34:56.789Z",
  "nonce": "k3p9m2x7"
}
```

- `nonce` は **同一スコア重複を回避** するための短いランダム文字列
  (= Sorted Set はメンバー一意制約があるため、 全フィールドが同じ 2 ランで
  片方が消えないようにする)
- GET レスポンスでは `nonce` を **削除して返す** (= クライアントには露出しない)

### key 戦略

- `version` と `regulation` で **物理的に分離** する (= フィルタが ZREVRANGE 1 発で済む)
- 全 version 横断クエリ (= `?regulation=NORMAL` のみ) は `SCAN MATCH ranking:*:NORMAL`
  でキー列挙 → 各キーから先頭 N 件取得 → メモリ上で score 降順マージ
- ランキングが肥大化したら `ZCARD` + `ZREMRANGEBYRANK 0 (size - cap - 1)` で
  **上位 N 件だけ残す** (= 既定 1000 件)

## 4. ゲームに URL を設定

3 通り。 Backend B の場合は **同一オリジン (`/api/ranking`)** が使えるため最もシンプル。

### A. localStorage (= 個別端末で設定)

DevTools コンソールで:

```js
localStorage.setItem("<prefix>.rankingApiUrl", "/api/ranking");
location.reload();
```

(= `<prefix>` は `js/constants.js` の `LS_PREFIX`)

または **タイトル画面のランキングボタン** から開いた modal で URL 未設定なら
入力欄が出るので、 そこに貼って 「保存」 する UI を組むのが推奨。

### B. URL hash bootstrap (= 共有しやすい一回限定リンク)

訪問者に下記のような hash 付き URL を踏ませると、 自動で localStorage に
保存されて以降同じ URL をハードコードしたかのように使える。

```
https://your-site/?#api=L2FwaS9yYW5raW5n
```

`L2FwaS9yYW5raW5n` は `btoa("/api/ranking")` の出力。 1 回踏めば以降は不要。

### C. ビルトイン (= リポジトリにハードコード)

`js/ranking-client.js` の `_DEFAULT_API_URL_ENC` に値をセットしてコミット:

```js
const _DEFAULT_API_URL_ENC = "L2FwaS9yYW5raW5n";   // = btoa("/api/ranking")
```

これで派生プロジェクトでは **明示的な設定なしで `/api/ranking` を叩く** 状態に
なる (= テンプレート本体の `_DEFAULT_API_URL_ENC` は空文字のまま据置)。

クロスオリジン (= フロントとは別ドメインに Vercel を置く) の場合は完全 URL
`"https://<project>.vercel.app/api/ranking"` を `btoa()` して埋め込む。

## 5. 不正対策

匿名 POST 可能なので、 必要に応じて追加 (= `tools/vercel-ranking.js` に
既に実装済 / コメントアウトで雛形済の項目):

- **score 上限** (= 実装済): `MAX_SCORE = 1_000_000` を超えたら 400 を返す
- **ペイロード上限** (= 実装済): `playerName` 30 文字 / `hero` 60 文字等で切詰め
- **メンバー上限** (= 実装済): `ZCARD` 監視で上位 1000 件のみ保持
- **rate limit** (= 雛形): `INCR rate:<ip>` + `EXPIRE rate:<ip> 60` で 60 秒
  N 回まで。 `X-Forwarded-For` ヘッダから IP を取る (= Vercel が付与)
- **HMAC**: 静的サイトでは secret を埋めにくいので obfuscation 程度
  (= Backend A と同じ判断)

個人プロジェクトでは **score 上限 + rate limit** で運用するのが現実的。

## 6. テスト用サンプルデータ投入

GAS のような 「エディタから関数を実行」 機能はないので、 **ローカルから curl
を回す** のが一番楽。 `tools/seed-vercel.sh` のような sh を派生で起こすと良い。

最小のシード例:

```bash
API=https://<your-project>.vercel.app/api/ranking

for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  curl -s -X POST "$API" \
    -H "Content-Type: text/plain;charset=utf-8" \
    -d "{\"playerName\":\"player$i\",\"score\":$((30000 - i * 1800 + RANDOM % 1500)),\"level\":$((30 - i)),\"kills\":$((420 - i * 30)),\"hero\":\"コナン・ドイル\",\"faction\":\"SEIRYU\",\"version\":\"0.1.0\",\"elapsedSec\":$((400 + i * 10)),\"regulation\":\"NORMAL\",\"regulationMul\":1.0}"
done

curl -s "$API?limit=20" | python3 -m json.tool
```

(= 12 件投入 → 上位 20 件取得して整形表示)

ヒーロー名は MCH 公式名 (= `https://github.com/bearko/mycryptoheroes` の
データベース) から引いて使うこと。 オリジナル名称は禁止
(= `CLAUDE.md` の MCH 経済圏の遵守 を参照)。

### 全消し

Redis CLI 相当を Upstash console (= web UI) から叩ける:

```
DEL ranking:0.1.0:NORMAL
```

または `tools/vercel-ranking.js` に **管理エンドポイント** を足す
(= `POST /api/ranking?action=clear&adminKey=<secret>`) のもアリ。 雛形は
コメントとして同ファイル末尾に残してある。

## 7. 参考リンク

- Vercel Functions: <https://vercel.com/docs/functions>
- Upstash Redis REST API: <https://upstash.com/docs/redis/features/restapi>
- Upstash for Vercel Marketplace: <https://vercel.com/marketplace/upstash>
- Redis Sorted Sets: <https://redis.io/docs/data-types/sorted-sets/>
- リファレンス Function: `tools/vercel-ranking.js` (= 派生で `api/ranking.js` にコピー)
- 既存実装: `js/ranking-client.js` (= 両 backend 共通の submit/fetch クライアント)

---

# Backend A — Google Apps Script + Spreadsheet (= 代替、 GAS で完結したい場合)

**Google Apps Script (GAS) Web App + Google Spreadsheet** をサーバーレス
バックエンドとして使う。 完全無料、 個人プロジェクト用途。 Vercel を使わない
構成で完結したい場合のみ選択する (= 既定は Backend B、 0 章参照)。

(= 既存解説 `docs/setup/google-apps-script.md` がデプロイ手順の汎用版。 本書は
ランキング用テーブル定義 / クライアント結線 / サンプルデータ投入まで含む
プロジェクト寄りの完全ガイド)

## 8. 全体構成

```
[ブラウザ]                        [Google Apps Script]      [Google Spreadsheet]
js/ranking-client.js   ──POST──▶  doPost(JSON body)   ───▶  ranking シートに追記
                       ──GET───▶  doGet(?limit=20)    ◀───  読み出し + score DESC + slice
                       ◀──JSON─
```

- フロントは `js/ranking-client.js` の `submitScore` / `fetchRanking`
- API URL は `localStorage["<prefix>.rankingApiUrl"]` (= `js/constants.js` の
  `LS_RANKING_API_URL`)、 または `js/ranking-client.js` の
  `_DEFAULT_API_URL_ENC` にビルトイン (= base64)
- サーバースクリプトは `tools/gas-ranking.gs`

## 9. デプロイ手順 (= 5 分)

### 9.1 Spreadsheet を作る

1. [Google ドライブ](https://drive.google.com/) で新規 Google Spreadsheet を作成
2. 名前は何でも (例: `<MyProject> Ranking`)
3. シートは初期 1 枚のままで OK (= スクリプトが自動で `ranking` シートを足す)

### 9.2 Apps Script に貼り付け

1. Spreadsheet メニュー: **拡張機能 → Apps Script**
2. 開いたエディタで `Code.gs` の中身を全削除
3. リポジトリの **`tools/gas-ranking.gs`** を全文コピー → エディタに貼り付け
4. 保存 (Ctrl+S / Cmd+S)、 プロジェクト名は `<MyProject> Ranking` などに変更しておくと整理しやすい

### 9.3 Web App としてデプロイ

1. 右上の **デプロイ** → **新しいデプロイ**
2. 種類: **ウェブアプリ**
3. 設定:
   - 説明: `Ranking v1` (任意)
   - 次のユーザーとして実行: **自分**
   - アクセスできるユーザー: **全員** (= 匿名アクセス許可)
4. **デプロイ** ボタン → 初回は権限承認ダイアログ (= スクリプトに Spreadsheet 編集権を付与)
5. 表示される **ウェブアプリの URL** をコピー
   - 形式: `https://script.google.com/macros/s/AKfycb.../exec`

### 9.4 動作確認

ブラウザで `{URL}?limit=5` を開く → `{"ok":true,"ranking":[]}` が返れば成功。

## 10. ゲームに URL を設定

3 通り。 用途に応じて使い分け:

### A. localStorage (= 個別端末で設定)

DevTools コンソールで:

```js
localStorage.setItem("<prefix>.rankingApiUrl", "https://script.google.com/macros/s/AKfycb.../exec");
location.reload();
```

(= `<prefix>` は `js/constants.js` の `LS_PREFIX`)

または **タイトル画面のランキングボタン** から開いた modal で URL 未設定なら
入力欄が出るので、 そこに貼って 「保存」 する UI を組むのが推奨。

### B. URL hash bootstrap (= 共有しやすい一回限定リンク)

訪問者に下記のような hash 付き URL を踏ませると、 自動で localStorage に
保存されて以降同じ URL をハードコードしたかのように使える。

```
https://your-site/?#api=BASE64ENCODED_API_URL
```

`BASE64ENCODED_API_URL` は `btoa(URL)` の出力。 1 回踏めば以降は不要。

### C. ビルトイン (= リポジトリにハードコード)

`js/ranking-client.js` の `_DEFAULT_API_URL_ENC` に `btoa(URL)` の値をセットしてコミット。
これで **誰でも同じバックエンドに記録される共通ランキング** になる。

```js
// 例 (= 値はダミー)
const _DEFAULT_API_URL_ENC = "aHR0cHM6Ly9zY3JpcHQuZ29vZ2xlLmNvbS9tYWNyb3MvLi4uL2V4ZWM=";
```

ビルトインすると **誰でも POST 可能** になる (= API URL が公知)。 適切な
制限を入れたい場合は **12 章 (= Backend A の不正対策)** 参照。

テンプレート (mycryptotemplate) では `_DEFAULT_API_URL_ENC` を **空文字** の
ままにしておくこと。 派生で個別 URL を埋める前提。 サンプル URL を残すと
全派生がそこに POST してしまう。

## 11. シートのデータ構造

`ranking` シートのヘッダー行 (= 1 行目):

| timestamp | playerName | score | level | kills | hero | faction | version | elapsedSec | regulation | regulationMul |

各行が 1 ラン。 score 降順で取れば上位ランキングになる。

| 列 | 例 | 型 |
|---|---|---|
| timestamp | `2026-05-10T12:34:56.789Z` | ISO 8601 文字列 |
| playerName | `bearko` | 文字列 (= max 30 chars 切詰めはクライアント側) |
| score | `12345` | 整数 |
| level | `27` | 整数 |
| kills | `412` | 整数 |
| hero | `コナン・ドイル` | 文字列 (= MCH 公式ヒーロー名) |
| faction | `SEIRYU` / `SUZAKU` / `BYAKKO` / `GENBU` / `KOURYU` | 文字列 |
| version | `0.1.0` | 文字列 (= `APP_VERSION`) |
| elapsedSec | `412` | 整数 |
| regulation | `NORMAL` / `ABSOLUTE` | 文字列 (= ゲームモード) |
| regulationMul | `1.0` 〜 `2.0` | 数値 (= score 倍率) |

`regulation` / `regulationMul` はゲーム側で別レギュレーション (= ハードモード等)
を実装しない場合は省略可。 doGet 側は **未指定なら NORMAL × 1.0 として返す**。

## 12. 不正対策 (= 任意、 後段)

匿名 POST 可能なので必要に応じて追加:

- **score 上限**: `if (score > 1_000_000) reject` を doPost に追加
- **rate limit**: PropertiesService に `lastPostMs[ip]` を保存して 5 sec throttle (※ GAS は IP を直接取得できないので簡易 token を使う等)
- **HMAC**: クライアントに `secret` を持たせ、 `hash = HMAC(secret, JSON.stringify(payload))` を送って検証 (= 静的サイトには secret を埋めにくいので obfuscation 程度の効果)

個人プロジェクトでは **score 上限のみ** で運用するのが現実的。

## 13. 再デプロイ時の注意

GAS は **新しいデプロイ** を作ると **新しい URL** が発行される。 既存 URL を維持したい場合は:

- 右上の **デプロイ** → 既存デプロイを編集 (= バージョンを進める) → 同じ URL を保持

## 14. ローカル開発時のテスト

GAS にデプロイせず本物のレスポンスをモックしたい場合:

```sh
# 仮想 endpoint (= 適当な GET/POST mock)
python3 -m http.server 8080
```

ローカル `http://localhost:8080` を `<prefix>.rankingApiUrl` に設定すると
`submitScore` の挙動 (= ボタン disabled / 送信中 / submitOk) は確認できる。
GET レスポンスは別途 mock する必要あり。

## 15. テスト用サンプルデータ投入

GAS エディタから手動実行できる関数を 3 つ提供しています:

| 関数 | 用途 |
|---|---|
| `seedSampleData()`   | `ranking` シートをリセット (= ヘッダー残し全削除) し、 **ヘッダー + 12 件のダミーデータ** を投入。 推奨 |
| `appendSampleData()` | 既存行はそのまま、 12 件 **追記**。 多数件 / 同一 player 名重複の挙動を見るとき |
| `clearAllRankings()` | ヘッダーは残して全データを削除 (= 開発時のクリーンアップ) |

### 手順

1. Apps Script エディタを開く (= 拡張機能 → Apps Script)
2. ファイルツリー上部の **関数選択ドロップダウン** で `seedSampleData` を選ぶ
3. **▶ 実行** ボタン → 初回は権限承認ダイアログ (= Spreadsheet 編集権)
4. Spreadsheet を見ると `ranking` シートに 1 行目ヘッダー + 12 件のサンプル
5. ゲームの 「ランキング」 ボタンから取得確認 (= score 降順で並ぶ)

サンプルの内訳:
- player: alice / ボブ / carol / デイブ / Eve / フランク / grace / ハイディ / ivan / ジュリア / kenji / リン
- hero: コナン・ドイル / 甲斐姫 / シートン / ピタゴラス / ライト兄弟 / スパルタクス / グリム兄弟 / 孫子 / 石田三成 / 許褚 (= MCH 公式ヒーロー)
- score: 30000 → 8000 程度のグラデーション + ±1500 jitter (= 1 位 ~30000、 12 位 ~8000)
- timestamp: 現在時刻から 7 時間ずつ過去にずらす (= 「最近のスコア」 に見えるデータ)

`?#api=...` 共有リンクで他の人と同じ Spreadsheet を見られる構成にしておけば、
自分以外の score も上位に並んで賑やかしになる。

## 16. 削除 / リセット

ランキングを全消ししたい時:
- Spreadsheet を直接開いて `ranking` シートをクリア (= ヘッダー行は残す)
- もしくは GAS エディタから **`clearAllRankings()`** を実行 (= ヘッダー残し全データ削除)

## 17. 参考リンク

- Apps Script Web App: <https://developers.google.com/apps-script/guides/web>
- ContentService API: <https://developers.google.com/apps-script/reference/content/content-service>
- 既存実装: `js/ranking-client.js` (= submit/fetch のクライアント)
- 既存ガイド: `docs/setup/google-apps-script.md` (= GAS デプロイの汎用解説)
- 既存パターン: `docs/patterns/07-ranking-integration.md` (= 設計の経緯 + 諸 hazard)
