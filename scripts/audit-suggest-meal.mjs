// scripts/audit-suggest-meal.mjs
//
// AUDIT_USER_ID=<uuid> node --import ./scripts/alias-loader.mjs --experimental-strip-types --env-file=.env.local scripts/audit-suggest-meal.mjs

import { createClient } from "@supabase/supabase-js";
import { suggestMeal } from "../lib/coach/nora-suggestions/suggest-meal.ts";
import { passesExclusions } from "../lib/coach/nora-suggestions/exclusions.ts";
import { getTodayTargets } from "../lib/morning/brief/get-today-targets.ts";
import { typedTargetsForAllSlots, DEFAULT_MEAL_RATIOS } from "../lib/food/meal-targets.ts";

const userId = process.env.AUDIT_USER_ID;
if (!userId) { console.error("AUDIT_USER_ID required"); process.exit(1); }
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { data: row } = await supabase
  .from("profiles")
  .select("eating_identity_cache, dietary_exclusions")
  .eq("user_id", userId)
  .single();

if (!row?.eating_identity_cache) {
  console.error("No eating_identity_cache — run /api/coach/eating-identity/sync first.");
  process.exit(1);
}

const targets = await getTodayTargets(supabase, userId);
const slotTargetsAll = targets ? typedTargetsForAllSlots(
  { kcal: targets.kcal, protein_g: targets.protein_g },
  targets.meal_ratios ?? DEFAULT_MEAL_RATIOS,
) : null;

const remainingMacros = { kcal: targets?.kcal ?? 2400, protein_g: targets?.protein_g ?? 180, carbs_g: targets?.carbs_g ?? 240, fat_g: targets?.fat_g ?? 70 };

for (const slot of ["breakfast", "lunch", "dinner", "snack"]) {
  console.log(`\n=== Slot: ${slot} ===`);
  const out = suggestMeal({
    slot,
    count: 5,
    eatingIdentity: row.eating_identity_cache,
    exclusions: row.dietary_exclusions ?? { tags: [], free_text: null, version: 1 },
    remainingMacros,
    slotTargets: slotTargetsAll?.[slot] ?? { kcal: 600, protein_g: 45 },
    preferNovelty: false,
  });
  console.log(`tier1_candidates=${out.filter_stats.tier1_candidates}  after_exclusion=${out.filter_stats.after_exclusion}  surfaced=${out.filter_stats.surfaced}`);
  if (out.error) { console.log(`⚠ error=${out.error}`); continue; }

  // INVARIANT: every surfaced item passes the exclusion filter.
  for (const s of out.suggestions) {
    const ok = passesExclusions(s.items.map((i) => ({ name: i.name })), (row.dietary_exclusions?.tags ?? []));
    if (!ok) {
      console.error(`❌ EXCLUSION LEAK: rank=${s.rank} items=${s.items.map((i) => i.name).join(", ")}`);
      process.exit(1);
    }
  }

  // INVARIANT: tier1 saturation when no variety pressure.
  if ((row.eating_identity_cache.monotone_flags.protein_top_share ?? 0) < 0.6) {
    if (out.filter_stats.tier1_candidates < out.filter_stats.surfaced && out.filter_stats.tier1_candidates > 0) {
      console.error(`⚠ tier1 under-served when no variety pressure: t1=${out.filter_stats.tier1_candidates}, surfaced=${out.filter_stats.surfaced}`);
    }
  }

  for (const s of out.suggestions) {
    console.log(`  #${s.rank} [${s.source}]  ${s.items.map((i) => `${i.name} ${i.qty_g}g`).join(" + ")}`);
    console.log(`     macros: ${Math.round(s.total_macros.kcal)}kcal ${Math.round(s.total_macros.protein_g)}P ${Math.round(s.total_macros.carbs_g)}C ${Math.round(s.total_macros.fat_g)}F`);
    console.log(`     scores: macro=${s.scores.macro_fit.toFixed(2)} fam=${s.scores.familiarity.toFixed(2)} variety=${s.scores.variety_boost.toFixed(2)} slot=${s.scores.slot_fit.toFixed(2)} final=${s.scores.final.toFixed(3)}`);
    console.log(`     rationale: ${s.rationale}`);
  }
}
