#!/usr/bin/env node
// scripts/audit-timezone-usage.mjs
//
// Forbidden-pattern grep. Exits non-zero if any disallowed UTC-date or
// raw getHours() call lives outside the allow-list.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();

// Catches today-leak shapes (live-clock as a stand-in for "today" in
// the user's tz). Intentionally narrower than `.toISOString().slice(0, 10)`
// alone — that pattern is legitimately used by pure UTC-day arithmetic
// helpers that walk N days from an already-keyed YMD string, which is
// timezone-irrelevant. The live-clock leak shape is `new Date()` (or
// `Date.now()`) chained directly to the slice, OR a raw `getHours()`
// call outside the allow-listed pure helpers.
const FORBIDDEN = [
  /new Date\(\)\.toISOString\(\)\.slice\(0,\s*10\)/,
  /new Date\(Date\.now\(\)\)\.toISOString\(\)\.slice\(0,\s*10\)/,
  /format\(\s*new Date\(\)\s*,\s*['"]yyyy-MM-dd['"]/,
  /\.getHours\(\)/,
];

const ALLOW = new Set([
  "lib/time.ts",
  "lib/food/meal-slot.ts",
  "lib/whoop.ts",
  "scripts/audit-timezone-usage.mjs",
]);

const ALLOW_PREFIX = ["scripts/", "_prototype.jsx"];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === ".git" || entry === ".superpowers" || entry === ".claude") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(entry)) out.push(full);
  }
  return out;
}

function isAllowed(rel) {
  if (ALLOW.has(rel)) return true;
  return ALLOW_PREFIX.some((p) => rel.startsWith(p));
}

const files = walk(ROOT);
const offenders = [];
for (const file of files) {
  const rel = relative(ROOT, file);
  if (isAllowed(rel)) continue;
  const src = readFileSync(file, "utf8");
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const pat of FORBIDDEN) {
      if (pat.test(lines[i])) {
        offenders.push({ file: rel, line: i + 1, text: lines[i].trim(), pat: String(pat) });
      }
    }
  }
}

if (offenders.length === 0) {
  console.log("audit-timezone-usage: ok (no forbidden patterns)");
  process.exit(0);
}

console.error(`audit-timezone-usage: ${offenders.length} forbidden pattern(s) found:`);
for (const o of offenders) {
  console.error(`  ${o.file}:${o.line}  [${o.pat}]  ${o.text}`);
}
process.exit(1);
