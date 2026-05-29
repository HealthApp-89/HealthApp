// lib/coach/nora-suggestions/recipe-discovery.ts
//
// Picks at most one "save this recipe" candidate from the user's
// eating_identity_cache.frequent_combos. Qualifying filter: combo seen ≥4×
// in the last 30 days AND last_seen within 14 days. Drops combos that
// overlap an existing user_food_items recipe (≥2 shared canonical items) and
// combos whose any member is itself a saved recipe. Deduped against
// proactive_nudge_dedup ("save_recipe:<sig>" trigger_key) within 30d, and
// rate-limited to 3 fires per user per 30d window.
//
// Wired into the daily cron in Task 17. Card payload variant is
// ProactiveNudgeCardPayload extends with kind:'save_recipe' (lib/data/types.ts).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { EatingIdentity, EatingIdentityCombo } from "@/lib/data/types";
import type { MealSlot } from "@/lib/food/types";
import { createHash } from "node:crypto";

// v1: QUALIFY_MIN_COUNT is checked against EatingIdentityCombo.co_occurrence_count
// which counts over the full 90-day composer window. Recency is gated by
// last_seen <= RECENCY_DAYS. Spec §9.1 originally said "≥4 in last 30 days"
// strictly; v1 approximates with 90d-count + 14d-recency. v2 may add a
// 30d-scoped count to EatingIdentityCombo. See spec §17 "v1 deviations".
const QUALIFY_MIN_COUNT = 4;
const RECENCY_DAYS = 14;
const RATE_LIMIT_WINDOW_DAYS = 30;
const RATE_LIMIT_MAX = 3;

export type SaveRecipeCandidate = {
  combo_signature: string;
  items: Array<{
    name: string;
    qty_g: number;
    per_100g: { kcal: number; protein_g: number; carbs_g: number; fat_g: number; fiber_g: number };
  }>;
  suggested_name: string;
  co_occurrence_count: number;
  last_seen: string;
  avg_slot: MealSlot;
  per_100g: { kcal: number; protein_g: number; carbs_g: number; fat_g: number; fiber_g: number };
};

const SLOT_MEAL_WORD: Record<MealSlot, string> = {
  breakfast: "plate",
  lunch: "bowl",
  dinner: "bowl",
  snack: "bite",
};

/** Stable signature for a combo. Order-independent — sort canonical names
 *  before hashing so {eggs, oats} and {oats, eggs} map to the same key. */
export function comboSignature(canonicalNames: string[]): string {
  return createHash("sha1")
    .update([...canonicalNames].sort().join("|"))
    .digest("hex")
    .slice(0, 12);
}

export async function pickDiscoveryCandidate(args: {
  supabase: SupabaseClient;
  userId: string;
  identity: EatingIdentity;
  today: string;
}): Promise<SaveRecipeCandidate | null> {
  const { supabase, userId, identity, today } = args;

  // 1. Filter combos by frequency threshold + recency.
  const recencyCutoff = shiftDays(today, -RECENCY_DAYS);
  const qualifying = identity.frequent_combos.filter(
    (c) => c.co_occurrence_count >= QUALIFY_MIN_COUNT && c.last_seen >= recencyCutoff,
  );
  if (qualifying.length === 0) return null;

  // 2. Drop combos that overlap an existing recipe (≥2 shared canonical items).
  const { data: libRecipes } = await supabase
    .from("user_food_items")
    .select("composite_of")
    .eq("user_id", userId)
    .not("composite_of", "is", null);
  const recipeItemSets = ((libRecipes ?? []) as Array<{
    composite_of: Array<{ name: string }> | null;
  }>).map((r) => new Set((r.composite_of ?? []).map((c) => c.name.toLowerCase())));

  const overlapsExisting = (combo: EatingIdentityCombo): boolean => {
    const candSet = new Set(combo.items.map((i) => i.toLowerCase()));
    for (const recipeSet of recipeItemSets) {
      let shared = 0;
      for (const n of candSet) if (recipeSet.has(n)) shared++;
      if (shared >= 2) return true;
    }
    return false;
  };

  const noOverlap = qualifying.filter((c) => !overlapsExisting(c));
  if (noOverlap.length === 0) return null;

  // 3. Drop combos whose any member is itself a library recipe.
  const { data: libRecipeNames } = await supabase
    .from("user_food_items")
    .select("name")
    .eq("user_id", userId)
    .not("composite_of", "is", null);
  const recipeNameSet = new Set(
    ((libRecipeNames ?? []) as Array<{ name: string }>).map((r) => r.name.toLowerCase()),
  );
  const noRecipeMember = noOverlap.filter(
    (c) => !c.items.some((i) => recipeNameSet.has(i.toLowerCase())),
  );
  if (noRecipeMember.length === 0) return null;

  // 4. Rate-limit + dedup against proactive_nudge_dedup.
  const sigsSorted = noRecipeMember
    .sort((a, b) => b.co_occurrence_count - a.co_occurrence_count)
    .map((c) => ({ combo: c, sig: comboSignature(c.items) }));

  const rateCutoff = shiftDays(today, -RATE_LIMIT_WINDOW_DAYS);
  const { data: dedupRows } = await supabase
    .from("proactive_nudge_dedup")
    .select("trigger_key, fired_on")
    .eq("user_id", userId)
    .like("trigger_key", "save_recipe:%")
    .gte("fired_on", rateCutoff);
  const consumed = ((dedupRows ?? []) as Array<{ trigger_key: string; fired_on: string }>).length;
  if (consumed >= RATE_LIMIT_MAX) return null;
  const blockedKeys = new Set(
    ((dedupRows ?? []) as Array<{ trigger_key: string }>).map((r) => r.trigger_key),
  );

  const winner = sigsSorted.find(({ sig }) => !blockedKeys.has(`save_recipe:${sig}`));
  if (!winner) return null;

  // 5. Resolve item qty + macros for the card. Pull typical_qty_g + per-100g
  //    macros from EatingIdentityTopItem when available; fall back to 100g and
  //    zero macros so the card still renders rather than crashing.
  const itemsResolved = winner.combo.items.map((canon) => {
    const top = identity.top_items.find((t) => t.canonical_name === canon);
    return {
      name: canon,
      qty_g: top?.typical_qty_g ?? 100,
      per_100g:
        top?.macros_per_100g ?? { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 },
    };
  });
  const totalQty = itemsResolved.reduce((s, i) => s + i.qty_g, 0) || 1;
  const totals = itemsResolved.reduce(
    (acc, i) => {
      const f = i.qty_g / 100;
      return {
        kcal: acc.kcal + i.per_100g.kcal * f,
        protein_g: acc.protein_g + i.per_100g.protein_g * f,
        carbs_g: acc.carbs_g + i.per_100g.carbs_g * f,
        fat_g: acc.fat_g + i.per_100g.fat_g * f,
        fiber_g: acc.fiber_g + i.per_100g.fiber_g * f,
      };
    },
    { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 },
  );
  const per_100g = {
    kcal: (totals.kcal / totalQty) * 100,
    protein_g: (totals.protein_g / totalQty) * 100,
    carbs_g: (totals.carbs_g / totalQty) * 100,
    fat_g: (totals.fat_g / totalQty) * 100,
    fiber_g: (totals.fiber_g / totalQty) * 100,
  };

  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const suggested_name = `${cap(winner.combo.avg_slot)} ${SLOT_MEAL_WORD[winner.combo.avg_slot]}`;

  return {
    combo_signature: winner.sig,
    items: itemsResolved,
    suggested_name,
    co_occurrence_count: winner.combo.co_occurrence_count,
    last_seen: winner.combo.last_seen,
    avg_slot: winner.combo.avg_slot,
    per_100g,
  };
}

function shiftDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
