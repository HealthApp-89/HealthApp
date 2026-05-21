// scripts/purge-low-precision-off-cache.mjs
//
// One-shot cleanup. Iterates food_db_cache rows where source='openfoodfacts'
// and computes token-overlap precision of name against the FIRST TOKEN of
// the name (synthetic short query). Rows whose precision is below 0.5 are
// noisy hits — packaged products that overlap weakly with the canonical
// food name. Deletes them (--apply) or just reports (--dry, default).
//
// Run via:
//   node --import ./scripts/alias-loader.mjs --experimental-strip-types \
//        --env-file=.env.local scripts/purge-low-precision-off-cache.mjs [--apply]

import { createClient } from "@supabase/supabase-js";

const STOPWORDS = new Set(["of", "the", "and", "a", "or", "with", "in"]);
const tokenize = (s) =>
  s.toLowerCase()
    .split(/[\s,.\-/()]+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));

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
  .select("canonical_id, source, name")
  .eq("source", "openfoodfacts")
  .limit(1000);
if (error) {
  console.error("Read failed", error);
  process.exit(1);
}

const offenders = [];
for (const row of data) {
  const tokens = tokenize(row.name);
  if (tokens.length === 0) continue;
  const firstToken = tokens[0];
  // Synthetic query = first token. precision = |{firstToken} ∩ tokens| / |tokens|.
  const precision = tokens.includes(firstToken) ? 1 / tokens.length : 0;
  if (precision < 0.5) {
    offenders.push({ canonical_id: row.canonical_id, name: row.name, tokens: tokens.length, precision });
  }
}

console.log(`Found ${offenders.length} low-precision OFF rows (precision < 0.5).`);
for (const o of offenders.slice(0, 25)) {
  console.log(`  ${o.precision.toFixed(2)} | ${o.tokens} toks | ${o.name}`);
}
if (offenders.length > 25) console.log(`  ...and ${offenders.length - 25} more.`);

if (!apply) {
  console.log("\nDry run — pass --apply to delete.");
  process.exit(0);
}

const ids = offenders.map((o) => o.canonical_id);
const { error: delErr } = await sb.from("food_db_cache").delete().in("canonical_id", ids);
if (delErr) {
  console.error("Delete failed", delErr);
  process.exit(1);
}
console.log(`Deleted ${ids.length} rows.`);
