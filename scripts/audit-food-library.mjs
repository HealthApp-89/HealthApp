#!/usr/bin/env node
// scripts/audit-food-library.mjs
//
// Read-only audit for v1.1: verifies food_recent_items and food_frequent_items
// outputs are internally consistent (no nulls in required fields, dedupe works,
// counts make sense). Also probes food_cache_search end-to-end.
//
// Run via:
//   AUDIT_USER_ID=<your-uuid> \
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types \
//        --env-file=.env.local scripts/audit-food-library.mjs

import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

const env = readFileSync(".env.local", "utf-8")
  .split("\n")
  .reduce((acc, line) => {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) acc[m[1]] = m[2].replace(/^"|"$/g, "");
    return acc;
  }, {});

const userId = process.env.AUDIT_USER_ID;
if (!userId) { console.error("Set AUDIT_USER_ID env var"); process.exit(1); }

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

console.log("→ food_recent_items(30, 20)");
const { data: recent, error: recentErr } = await supabase.rpc("food_recent_items", { p_user_id: userId, p_days: 30, p_limit: 20 });
if (recentErr) throw recentErr;
console.log(`  ${recent.length} rows`);
for (const r of recent) {
  assert.ok(r.name, "recent.name required");
  assert.ok(typeof r.qty_g === "number" || typeof r.qty_g === "string", "recent.qty_g required");
  assert.ok(r.per_100g, "recent.per_100g required");
  assert.ok(["db", "llm"].includes(r.source), "recent.source must be db/llm");
}
const recentNames = recent.map((r) => r.name.toLowerCase());
assert.equal(recentNames.length, new Set(recentNames).size, "recent must be deduped by name");

console.log("→ food_frequent_items(30, 20)");
const { data: frequent, error: freqErr } = await supabase.rpc("food_frequent_items", { p_user_id: userId, p_days: 30, p_limit: 20 });
if (freqErr) throw freqErr;
console.log(`  ${frequent.length} rows`);
for (const f of frequent) {
  assert.ok(typeof f.occurrence_count === "number" && f.occurrence_count >= 1, "frequent.occurrence_count must be >= 1");
}
const freqNames = frequent.map((f) => f.name.toLowerCase());
assert.equal(freqNames.length, new Set(freqNames).size, "frequent must be deduped by name");

console.log("→ food_cache_search('chicken', 10)");
const { data: catalog, error: catErr } = await supabase.rpc("food_cache_search", { q: "chicken", p_limit: 10 });
if (catErr) throw catErr;
console.log(`  ${catalog.length} matches`);

console.log("\n✓ audit-food-library passed");
