#!/usr/bin/env node
// ============================================================
// tools/build-spec-index.mjs — SPEC-INDEX.md を SPEC frontmatter から再生成
// (= SPEC-032 の自動化)
// ============================================================
//
// 使い方: `node tools/build-spec-index.mjs`
// 依存: なし (= 純 Node ESM、 no npm)
//
// 各 docs/specs/SPEC-NNN-*.md は冒頭に YAML frontmatter を持つ:
//   ---
//   id: SPEC-NNN
//   title: Short Title
//   status: Implementing | Done | Cancelled
//   pr: 39                  # PR 番号 (= 数値) または "feat/..." (= branch 名)
//   phase: Phase 0 / Phase 1
//   ---
//
// このスクリプトは全 SPEC-*.md をスキャンして frontmatter から表を組み立て、
// docs/specs/SPEC-INDEX.md の `<!-- BEGIN AUTO-INDEX -->` ... `<!-- END AUTO-INDEX -->`
// マーカー間を **完全置換** する (= 表以外の文章は手動編集 OK)。

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname  = dirname(fileURLToPath(import.meta.url));
const SPECS_DIR  = join(__dirname, "..", "docs", "specs");
const INDEX_PATH = join(SPECS_DIR, "SPEC-INDEX.md");
const BEGIN      = "<!-- BEGIN AUTO-INDEX -->";
const END        = "<!-- END AUTO-INDEX -->";

/**
 * ごく簡素な YAML frontmatter parser。 `---` で囲まれたブロック内の
 * `key: value` 行を読む。 ネスト / 配列 / 改行値は対象外 (= 必要なら拡張)。
 */
function parseFrontmatter(text) {
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---", 4);
  if (end < 0) return null;
  const body = text.slice(4, end);
  const out = {};
  for (const line of body.split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

function specNumOf(id) {
  const m = String(id).match(/SPEC-(\d+)/);
  return m ? parseInt(m[1], 10) : -1;
}

/**
 * marker 文字列が **行頭** に出現する位置を返す (= fragment 本文中の literal mention を回避)。
 * BOF または `\n` の直後に marker、 直後は `\n` または EOF を要求。
 */
function findLineAnchored(text, marker) {
  let from = 0;
  while (from <= text.length) {
    const i = text.indexOf(marker, from);
    if (i < 0) return -1;
    const charBefore = i === 0 ? "\n" : text[i - 1];
    const after = i + marker.length;
    const charAfter = after >= text.length ? "\n" : text[after];
    if (charBefore === "\n" && (charAfter === "\n" || charAfter === undefined)) return i;
    from = i + 1;
  }
  return -1;
}

function prCell(status, pr) {
  if (!pr) return "—";
  // 数値 PR 番号は #N、 branch 名はそのまま
  const isNum = /^\d+$/.test(String(pr));
  const ref   = isNum ? `#${pr}` : String(pr);
  if (status === "Done")        return `${ref} (merged)`;
  if (status === "Cancelled")   return `${ref} (closed)`;
  return isNum ? `${ref} (open)` : ref;
}

function main() {
  const files = readdirSync(SPECS_DIR)
    .filter(f => /^SPEC-\d{3}-.+\.md$/.test(f))
    .sort();

  const rows = [];
  for (const f of files) {
    const path = join(SPECS_DIR, f);
    const text = readFileSync(path, "utf8");
    const fm   = parseFrontmatter(text);
    if (!fm) {
      console.warn(`[skip] no frontmatter: ${f}`);
      continue;
    }
    const id     = fm.id ?? `SPEC-${f.match(/^SPEC-(\d+)/)[1]}`;
    const title  = fm.title ?? "(untitled)";
    const status = fm.status ?? "Draft";
    const pr     = fm.pr ?? "";
    const phase  = fm.phase ?? "Phase 0 / Phase 1";
    rows.push({ num: specNumOf(id), id, title, status, pr, phase });
  }
  rows.sort((a, b) => a.num - b.num);

  let body = "";
  body += "| ID | タイトル | Status | Phase | 実装 PR |\n";
  body += "|---|---|---|---|---|\n";
  for (const r of rows) {
    body += `| ${r.id} | ${r.title} | ${r.status} | ${r.phase} | ${prCell(r.status, r.pr)} |\n`;
  }

  // SPEC-INDEX.md の AUTO-INDEX マーカー間を置換 (= 行頭 anchor で fragment 本文中の mention を誤検出しない)
  let index = readFileSync(INDEX_PATH, "utf8");
  const beginIdx = findLineAnchored(index, BEGIN);
  const endIdx   = findLineAnchored(index, END);
  if (beginIdx < 0 || endIdx < 0 || endIdx < beginIdx) {
    console.error("[error] BEGIN/END AUTO-INDEX マーカーが SPEC-INDEX.md に見つかりません");
    process.exit(1);
  }
  const before = index.slice(0, beginIdx + BEGIN.length);
  const after  = index.slice(endIdx);
  const next   = `${before}\n${body}${after}`;
  if (next === index) {
    console.log("[ok] SPEC-INDEX.md は最新 (= no change)");
  } else {
    writeFileSync(INDEX_PATH, next);
    console.log(`[ok] SPEC-INDEX.md を更新 (= ${rows.length} entries)`);
  }
}

main();
