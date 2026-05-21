// scripts/backfill-usda-kcal-cache.mjs
//
// One-shot fix for food_db_cache rows where source='usda' and per_100g.kcal=0
// because the old extractor only checked USDA nutrient #208. Foundation Foods
// publish kcal under #1008 (and sometimes #957 / #958 Atwater variants) — that
// got missed, the cache was poisoned, and every subsequent lookup of the same
// food returned a 0-kcal item.
//
// This script re-extracts kcal from the stored raw_payload using the SAME
// priority list the new extractUsdaMacros uses, and updates the row in place.
// Idempotent: rows that already have kcal > 0 are left alone.
//
// Run via:
//   node --env-file=.env.local scripts/backfill-usda-kcal-cache.mjs [--apply]

import { createClient } from "@supabase/supabase-js";

const ENERGY_KCAL_CODES = ["1008", "208", "958", "957"];
function extractKcal(food) {
  for (const num of ENERGY_KCAL_CODES) {
    const n = (food.foodNutrients ?? []).find((x) => x.nutrientNumber === num);
    if (typeof n?.value === "number" && n.value > 0 && Number.isFinite(n.value)) {
      return n.value;
    }
  }
  return 0;
}

const apply = process.argv.includes("--apply");
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const sr = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !sr) {
  console.error("Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const sb = createClient(url, sr);

const { data, error } = await sb
  .from("food_db_cache")
  .select("canonical_id, name, per_100g, raw_payload")
  .eq("source", "usda");
if (error) {
  console.error("Read failed", error);
  process.exit(1);
}

const fixes = [];
for (const row of data ?? []) {
  const currentKcal = row.per_100g?.kcal ?? 0;
  if (currentKcal > 0) continue; // already fine
  const fresh = extractKcal(row.raw_payload ?? {});
  if (fresh > 0) {
    fixes.push({ canonical_id: row.canonical_id, name: row.name, before: currentKcal, after: fresh });
  }
}

console.log(`Found ${fixes.length} USDA cache rows with kcal=0 that can be recovered from raw_payload.`);
for (const f of fixes.slice(0, 30)) {
  console.log(`  ${String(f.before).padStart(4)} → ${String(f.after).padStart(4)} kcal  |  ${f.name}`);
}
if (fixes.length > 30) console.log(`  ...and ${fixes.length - 30} more.`);

if (!apply) {
  console.log("\nDry run — pass --apply to update.");
  process.exit(0);
}

let updated = 0;
for (const f of fixes) {
  // Fetch current per_100g (already in `data`) and patch kcal in place.
  const row = data.find((r) => r.canonical_id === f.canonical_id);
  const nextPer100g = { ...(row.per_100g ?? {}), kcal: f.after };
  const { error: updErr } = await sb
    .from("food_db_cache")
    .update({ per_100g: nextPer100g })
    .eq("canonical_id", f.canonical_id);
  if (updErr) {
    console.error(`  FAIL ${f.canonical_id}:`, updErr.message);
    continue;
  }
  updated++;
}
console.log(`Updated ${updated} rows.`);
