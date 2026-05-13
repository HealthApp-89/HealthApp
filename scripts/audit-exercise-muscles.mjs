#!/usr/bin/env node
// scripts/audit-exercise-muscles.mjs
//
// One-off audit that walks the user's distinct logged exercise names and
// reports which ones aren't covered by EXERCISE_MUSCLES in
// lib/coach/exercise-muscles.ts. Use after PR #57 to identify the gap
// that's making "click to highlight" inert for some real-world exercises.
//
// Usage:
//   node scripts/audit-exercise-muscles.mjs

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// .env.local has values like postgres://... with special chars; the supabase
// CLI parser chokes on it, so read it directly.
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

// Extract the EXERCISE_MUSCLES keys from the source file by string-matching
// each "<key>": { primary: [...], secondary: [...] } row. Avoids needing to
// run TS in the script.
const src = readFileSync(resolve(repoRoot, "lib/coach/exercise-muscles.ts"), "utf-8");
const lookupKeys = new Set();
{
  // Crude but reliable: find the EXERCISE_MUSCLES block and grep keys inside it.
  const start = src.indexOf("EXERCISE_MUSCLES: Record<string, MuscleMapping>");
  const end = src.indexOf("TYPE_FALLBACK", start);
  const block = src.slice(start, end);
  for (const line of block.split("\n")) {
    const m = line.match(/^\s*"([^"]+)":\s*\{/);
    if (m) lookupKeys.add(m[1]);
  }
}

// Match the runtime normalizer in lib/coach/exercise-muscles.ts.
function normalize(s) {
  return s
    .toLowerCase()
    .replace(/\([^)]*\)/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
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

console.log(`# Audit: EXERCISE_MUSCLES coverage vs DB`);
console.log(`# Lookup keys: ${lookupKeys.size}`);
console.log(`# Distinct logged exercises: ${distinct.size}`);
console.log("");

console.log("## All distinct exercise names (raw → normalized → hit?):");
for (const name of distinctSorted) {
  const norm = normalize(name);
  const hit = lookupKeys.has(norm) ? "✓" : "✗";
  console.log(`  ${hit}  ${name.padEnd(45)}  → ${norm}`);
}
console.log("");

const unmapped = distinctSorted.filter((n) => !lookupKeys.has(normalize(n)));
console.log(`## Unmapped (${unmapped.length}):`);
for (const name of unmapped) {
  console.log(`  ${name}   (normalized: ${JSON.stringify(normalize(name))})`);
}
