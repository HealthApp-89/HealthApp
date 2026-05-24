// scripts/audit-nutrition-intelligence.mjs
//
// Read-only audit. Set AUDIT_USER_ID. Runs composeFoodQuality + prints
// per-item classification rows + final bar percentages. Use to inspect
// mis-classifications before they propagate to the live trends view.
//
// Run: AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs \
//      --experimental-strip-types --env-file=.env.local \
//      scripts/audit-nutrition-intelligence.mjs

import { createClient } from "@supabase/supabase-js";
import { composeFoodQuality } from "../lib/coach/nutrition-intelligence/compose-food-quality.ts";
import { classifyProtein, classifyCarb, classifyCookingMethod } from "../lib/coach/nutrition-intelligence/classify.ts";

const userId = process.env.AUDIT_USER_ID;
if (!userId) {
  console.error("AUDIT_USER_ID env var required");
  process.exit(1);
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const today = new Date().toISOString().slice(0, 10);

console.log(`\n── Nutrition intelligence audit · user=${userId} · today=${today} ──\n`);

// 1. Per-item classification dump — iterate food_log_entries.items jsonb array.
const { data: entries, error } = await supabase
  .from("food_log_entries")
  .select("id, eaten_at, meal_slot, items")
  .eq("user_id", userId)
  .eq("status", "committed")
  .gte("eaten_at", new Date(Date.now() - 14 * 86400000).toISOString())
  .order("eaten_at", { ascending: false });
if (error) { console.error(error); process.exit(1); }

const itemCount = (entries ?? []).reduce((n, e) => n + (e.items?.length ?? 0), 0);
console.log(`Last 14d: ${entries?.length ?? 0} committed entries · ${itemCount} items\n`);
console.log("Item                                        Protein         Carb            Cooking");
console.log("─".repeat(110));
for (const e of entries ?? []) {
  for (const item of e.items ?? []) {
    const p = classifyProtein(item.name);
    const c = classifyCarb(item.name);
    const m = classifyCookingMethod(item.name);
    console.log(
      `${item.name.padEnd(44).slice(0,44)}${p.category.padEnd(16)}${c.category.padEnd(16)}${m.method}`,
    );
  }
}

// 2. Composer output.
console.log("\n── composeFoodQuality output ──\n");
const trend = await composeFoodQuality({ supabase, userId, today });
console.log(`Total items: ${trend.total_items}`);
console.log(`Data completeness: protein ${(trend.data_completeness.protein_classified_pct*100).toFixed(0)}% · carb ${(trend.data_completeness.carb_classified_pct*100).toFixed(0)}% · cooking ${(trend.data_completeness.cooking_method_inferable_pct*100).toFixed(0)}%`);

console.log("\nProtein sources (% of classified protein-g):");
for (const s of trend.protein_sources) {
  console.log(`  ${s.category.padEnd(20)}${(s.pct*100).toFixed(1).padStart(6)}%  (${s.grams.toFixed(0)}g)`);
}

console.log("\nCarb sources (% of classified carb-g):");
for (const s of trend.carb_sources) {
  console.log(`  ${s.category.padEnd(20)}${(s.pct*100).toFixed(1).padStart(6)}%  (${s.grams.toFixed(0)}g)`);
}

console.log("\nCooking methods (% of classified-method items):");
for (const m of trend.cooking_methods) {
  console.log(`  ${m.method.padEnd(20)}${(m.pct*100).toFixed(1).padStart(6)}%  (${m.count} items)`);
}

console.log(`\nDiversity: ${trend.diversity.distinct_items} distinct · ${trend.diversity.fish_meals_per_week.toFixed(1)} fish/wk · ${trend.diversity.veg_servings_per_day.toFixed(1)} veg/day\n`);
