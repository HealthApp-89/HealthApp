#!/usr/bin/env node
// scripts/audit-exercise-categories.mjs
//
// One-off audit that walks the user's distinct logged exercise names and
// reports which ones aren't covered by lib/coach/exercise-categories.ts.
//
// Usage (loads .env.local via dotenv-style read; doesn't depend on the
// supabase CLI's flaky env parser):
//
//   node scripts/audit-exercise-categories.mjs
//
// Prints two sections to stdout:
//   1. Distinct lowercase exercise names from the exercises table.
//   2. Names whose normalized form does NOT match an entry in EXERCISE_CATEGORY.
//
// You should hand-categorize the second section and add entries to the
// lookup file, then re-run until the second section is empty.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// Read .env.local manually — supabase CLI's parser chokes on it.
const envPath = resolve(repoRoot, ".env.local");
const env = {};
for (const line of readFileSync(envPath, "utf-8").split("\n")) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m) env[m[1]] = m[2];
}

const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const sb = createClient(url, key, { auth: { persistSession: false } });

// Pull the lookup from the source file at runtime so we don't have to
// keep a duplicate copy in the script.
const catFile = readFileSync(resolve(repoRoot, "lib/coach/exercise-categories.ts"), "utf-8");
const lookupKeys = new Set();
for (const line of catFile.split("\n")) {
  const m = line.match(/^\s*"([^"]+)":\s*"[a-z-]+",?\s*(\/\/.*)?$/);
  if (m) lookupKeys.add(m[1]);
}

function normalize(s) {
  return s.toLowerCase()
    .replace(/\s*\(.*?\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const { data, error } = await sb.from("exercises").select("name");
if (error) {
  console.error("query failed:", error.message);
  process.exit(1);
}

const distinct = new Set(data.map((r) => r.name.trim()));
const distinctSorted = [...distinct].sort((a, b) => a.localeCompare(b));

console.log(`# Audit: exercise-categories vs DB`);
console.log(`# Lookup keys (lib/coach/exercise-categories.ts): ${lookupKeys.size}`);
console.log(`# Distinct logged exercises: ${distinct.size}`);
console.log("");

console.log("## All distinct exercise names (lower-cased, normalized → bucket):");
for (const name of distinctSorted) {
  const norm = normalize(name);
  const hit = lookupKeys.has(norm) ? "✓" : "✗";
  console.log(`  ${hit}  ${name.padEnd(40)}  → ${norm}`);
}
console.log("");

const uncategorized = distinctSorted.filter((n) => !lookupKeys.has(normalize(n)));
console.log(`## Uncategorized (${uncategorized.length}):`);
for (const name of uncategorized) {
  console.log(`  ${name}  (normalized: ${JSON.stringify(normalize(name))})`);
}
