**Changed — MyCryptoTCG プロジェクト Charter + localStorage prefix `mctcg` (Day 1 Phase 0)**

- `js/constants.js`: `LS_PREFIX = "<prefix>"` → `"mctcg"`、 `ASSET_BASE` を `https://raw.githubusercontent.com/bearko/mycryptotcg/main/assets/` に更新
- `docs/charters/PROJECT_CHARTER.md`: テンプレ placeholder を全削除し、 `MYCRYPTOTCG-KICKOFF.md` 1〜4 章から目的 / スコープ / 成功基準 / リリース計画を展開
- `index.html`: `<title>` / `og:title` / `og:description` を MyCryptoTCG 表記に
- `README.md`: 冒頭に MCT 概要を追加 (= テンプレ Day 1 Kickoff 本文は派生用の参考として残す)
- スプライト先行 3 体は MCH `heroId 1 / 2 / 3` で確定 (= 正式名は Phase 1A で MCH master DB から引用、 オリジナル名は付けない)
- 実装ロジック (= カードデータ / 戦闘 / UI / スプライト) は本 SPEC のスコープ外。 SPEC-102 以降で順次
