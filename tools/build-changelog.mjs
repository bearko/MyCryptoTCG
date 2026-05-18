#!/usr/bin/env node
// ============================================================
// tools/build-changelog.mjs — CHANGELOG.md の [Unreleased] を fragments から再生成
// (= SPEC-032 の自動化)
// ============================================================
//
// 使い方: `node tools/build-changelog.mjs`
// 依存: なし (= 純 Node ESM、 no npm)
//
// 各 docs/changelog/SPEC-NNN.md は **bullet list のみ** を持つ:
//   - **change 1**
//   - change 2
//
// 対応する docs/specs/SPEC-NNN-*.md の YAML frontmatter から:
//   - id (SPEC-NNN)
//   - title
//   - status (= Implementing / Done で `— merged in #N` を付加)
//   - pr (= 数値で merged 時の参照)
//   - kind (= Added / Changed / Fixed / Removed、 fallback "Changed")
// を取って section 見出しを組み立てる。
//
// CHANGELOG.md の `<!-- BEGIN AUTO-UNRELEASED -->` ... `<!-- END AUTO-UNRELEASED -->`
// マーカー間を **完全置換**。 過去の `## [SPEC-NNN]` セクション以下は触らない。

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname     = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT     = join(__dirname, "..");
const SPECS_DIR     = join(REPO_ROOT, "docs", "specs");
const CHANGELOG_DIR = join(REPO_ROOT, "docs", "changelog");
const CHANGELOG     = join(REPO_ROOT, "CHANGELOG.md");
const BEGIN         = "<!-- BEGIN AUTO-UNRELEASED -->";
const END           = "<!-- END AUTO-UNRELEASED -->";

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

function loadSpecMeta() {
  const map = new Map();   // id → frontmatter
  for (const f of readdirSync(SPECS_DIR)) {
    if (!/^SPEC-\d{3}-.+\.md$/.test(f)) continue;
    const text = readFileSync(join(SPECS_DIR, f), "utf8");
    const fm   = parseFrontmatter(text);
    if (!fm || !fm.id) continue;
    map.set(fm.id, fm);
  }
  return map;
}

function loadFragments() {
  const out = [];   // {id, num, body}
  let dirEntries = [];
  try { dirEntries = readdirSync(CHANGELOG_DIR); } catch (_) {}
  for (const f of dirEntries) {
    if (!/^SPEC-\d{3}\.md$/.test(f)) continue;
    const id   = f.replace(/\.md$/, "");
    const num  = specNumOf(id);
    const body = readFileSync(join(CHANGELOG_DIR, f), "utf8").replace(/\n+$/, "");
    out.push({ id, num, body });
  }
  out.sort((a, b) => b.num - a.num);   // 新しい SPEC が上
  return out;
}

function renderHeading(meta, id) {
  const kind   = meta?.kind   ?? "Changed";
  const title  = meta?.title  ?? id;
  const status = meta?.status ?? "Implementing";
  const pr     = meta?.pr;
  const isNum  = pr && /^\d+$/.test(String(pr));
  const suffix = (status === "Done" && isNum) ? ` — merged in #${pr}` : "";
  return `### ${kind} — ${id} (= ${title})${suffix}`;
}

function main() {
  const specMeta  = loadSpecMeta();
  const fragments = loadFragments();

  let block = "";
  for (const frag of fragments) {
    const meta = specMeta.get(frag.id);
    if (!meta) {
      console.warn(`[skip] fragment without spec frontmatter: ${frag.id}`);
      continue;
    }
    block += `${renderHeading(meta, frag.id)}\n${frag.body}\n\n`;
  }
  block = block.replace(/\n+$/, "\n");

  let log = readFileSync(CHANGELOG, "utf8");
  const beginIdx = findLineAnchored(log, BEGIN);
  const endIdx   = findLineAnchored(log, END);
  if (beginIdx < 0 || endIdx < 0 || endIdx < beginIdx) {
    console.error("[error] BEGIN/END AUTO-UNRELEASED マーカーが CHANGELOG.md に見つかりません");
    process.exit(1);
  }
  const before = log.slice(0, beginIdx + BEGIN.length);
  const after  = log.slice(endIdx);
  const next   = `${before}\n${block}${after}`;
  if (next === log) {
    console.log("[ok] CHANGELOG.md は最新 (= no change)");
  } else {
    writeFileSync(CHANGELOG, next);
    console.log(`[ok] CHANGELOG.md を更新 (= ${fragments.length} fragments)`);
  }
}

main();
