// scripts/audit-eating-identity.mjs
//
// AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-eating-identity.mjs

import { createClient } from "@supabase/supabase-js";
import { composeEatingIdentity } from "../lib/coach/nora-suggestions/compose-eating-identity.ts";

const userId = process.env.AUDIT_USER_ID;
if (!userId) { console.error("AUDIT_USER_ID required"); process.exit(1); }
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const today = new Date().toISOString().slice(0, 10);
const payload = await composeEatingIdentity({ supabase, userId, today });

console.log(`\n=== Eating identity for ${userId} on ${today} ===`);
console.log(`Window: ${payload.window_days}d, ${payload.top_items.length} unique items ranked\n`);

console.log("TOP 20 ITEMS:");
for (const it of payload.top_items.slice(0, 20)) {
  console.log(`  ${it.log_count.toString().padStart(3)}× ${it.canonical_name}  (${it.source}${it.library_item_id ? "/" + it.library_item_id.slice(0, 8) : ""})  qty≈${it.typical_qty_g}g  last=${it.last_logged}`);
  if (it.name_variants.length > 5) {
    console.log(`     ⚠ variants leak (${it.name_variants.length}): ${it.name_variants.slice(0, 8).join(" | ")}`);
  }
}

console.log("\nPROTEIN CATEGORY COUNTS:");
for (const [k, v] of Object.entries(payload.protein_category_counts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(20)} ${v.toFixed(1)}`);
}

console.log("\nCARB CATEGORY COUNTS:");
for (const [k, v] of Object.entries(payload.carb_category_counts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(20)} ${v.toFixed(1)}`);
}

console.log("\nTOP 10 COMBOS:");
for (const c of payload.frequent_combos.slice(0, 10)) {
  console.log(`  ${c.co_occurrence_count}×  ${c.items.join(" + ")}  (avg_slot=${c.avg_slot}, last=${c.last_seen})`);
}

console.log("\nMONOTONE FLAGS:");
console.log(`  protein_top_share: ${(payload.monotone_flags.protein_top_share * 100).toFixed(1)}%`);
console.log(`  carb_top_share:    ${(payload.monotone_flags.carb_top_share * 100).toFixed(1)}%`);
console.log(`  most_repeated_meal: ${payload.monotone_flags.most_repeated_meal ? `${payload.monotone_flags.most_repeated_meal.count}× ${payload.monotone_flags.most_repeated_meal.items.join(" + ")}` : "none"}`);

const total = payload.top_items.reduce((s, i) => s + i.log_count, 0);
const unknownPCount = payload.protein_category_counts["unknown"] ?? 0;
const unknownCCount = payload.carb_category_counts["unknown"] ?? 0;
console.log(`\nUNKNOWN SHARE (sanity): protein=${(unknownPCount * 100 / (total || 1)).toFixed(1)}%, carb=${(unknownCCount * 100 / (total || 1)).toFixed(1)}%`);
if (unknownPCount / (total || 1) > 0.15) {
  console.log("⚠  > 15% unknown protein share — token list may need extension or library items need explicit categories (v2 follow-up).");
}
