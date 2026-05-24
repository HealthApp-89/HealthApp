// lib/coach/nutrition-intelligence/compose-food-quality.ts
//
// 14-day aggregation: per-item classification → category-grouped grams /
// counts. Reads food_log_entries (status='committed') and joins
// food_db_cache via db_ref->>'canonical_id' for the USDA foodCategory.

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  FoodQualityTrend,
  ProteinCategory,
  CarbCategory,
  CookingMethod,
} from "@/lib/data/types";
import { FOOD_QUALITY_WINDOW_DAYS } from "./thresholds";
import { classifyProtein, classifyCarb, classifyCookingMethod } from "./classify";

type FoodLogRow = {
  id: string;
  name: string;
  protein_g: number | null;
  carbs_g: number | null;
  meal_slot: string;
  eaten_at: string;
  db_ref: { source: string; canonical_id: string } | null;
};

type CacheRow = {
  canonical_id: string;
  raw_payload: Record<string, unknown> | null;
};

export async function composeFoodQuality(args: {
  supabase: SupabaseClient;
  userId: string;
  today: string;
}): Promise<FoodQualityTrend> {
  const { supabase, userId, today } = args;
  const windowStart = shiftDays(today, -FOOD_QUALITY_WINDOW_DAYS);
  const windowStartIso = `${windowStart}T00:00:00Z`;
  const todayIso = `${today}T23:59:59Z`;

  // 1. Fetch committed food log entries in the window.
  const { data: entries, error } = await supabase
    .from("food_log_entries")
    .select("id, name, protein_g, carbs_g, meal_slot, eaten_at, db_ref")
    .eq("user_id", userId)
    .eq("status", "committed")
    .gte("eaten_at", windowStartIso)
    .lte("eaten_at", todayIso);
  if (error) throw error;
  const rows = (entries as FoodLogRow[] | null) ?? [];

  // 2. Batch-fetch USDA category from food_db_cache for items with db_ref.
  const canonicalIds = [
    ...new Set(
      rows
        .map((r) => r.db_ref?.canonical_id)
        .filter((x): x is string => typeof x === "string"),
    ),
  ];
  const cacheByCanonical = new Map<string, string | null>();
  if (canonicalIds.length > 0) {
    const { data: cacheRows, error: cacheErr } = await supabase
      .from("food_db_cache")
      .select("canonical_id, raw_payload")
      .in("canonical_id", canonicalIds);
    if (cacheErr) throw cacheErr;
    for (const c of (cacheRows as CacheRow[] | null) ?? []) {
      const cat = extractUsdaCategory(c.raw_payload);
      cacheByCanonical.set(c.canonical_id, cat);
    }
  }

  // 3. Classify each row + accumulate.
  const proteinBuckets = new Map<ProteinCategory, number>();
  const carbBuckets    = new Map<CarbCategory,    number>();
  const cookingBuckets = new Map<CookingMethod,   number>();

  let proteinClassifiedG = 0;
  let proteinTotalG = 0;
  let carbClassifiedG = 0;
  let carbTotalG = 0;
  let cookingClassifiedN = 0;
  const distinctNames = new Set<string>();
  const fishMealKeys = new Set<string>();   // `${date}|${meal_slot}` if any fish item
  let vegItemCount = 0;

  for (const r of rows) {
    const usdaCat = r.db_ref?.canonical_id
      ? cacheByCanonical.get(r.db_ref.canonical_id) ?? null
      : null;

    const p = classifyProtein(r.name, usdaCat);
    const c = classifyCarb(r.name, usdaCat);
    const m = classifyCookingMethod(r.name);

    const pg = r.protein_g ?? 0;
    const cg = r.carbs_g ?? 0;

    proteinTotalG += pg;
    if (p.category !== "unknown") {
      proteinBuckets.set(p.category, (proteinBuckets.get(p.category) ?? 0) + pg);
      proteinClassifiedG += pg;
    }

    carbTotalG += cg;
    if (c.category !== "unknown") {
      carbBuckets.set(c.category, (carbBuckets.get(c.category) ?? 0) + cg);
      carbClassifiedG += cg;
    }

    if (m.method !== "unknown") {
      cookingBuckets.set(m.method, (cookingBuckets.get(m.method) ?? 0) + 1);
      cookingClassifiedN += 1;
    }

    distinctNames.add(r.name.toLowerCase().trim());

    if (p.category === "fish_seafood") {
      const dateKey = r.eaten_at.slice(0, 10);
      fishMealKeys.add(`${dateKey}|${r.meal_slot}`);
    }
    if (c.category === "non_starchy_veg") vegItemCount += 1;
  }

  const protein_sources = [...proteinBuckets.entries()]
    .map(([category, grams]) => ({
      category,
      grams,
      pct: proteinClassifiedG > 0 ? grams / proteinClassifiedG : 0,
    }))
    .sort((a, b) => b.grams - a.grams);

  const carb_sources = [...carbBuckets.entries()]
    .map(([category, grams]) => ({
      category,
      grams,
      pct: carbClassifiedG > 0 ? grams / carbClassifiedG : 0,
    }))
    .sort((a, b) => b.grams - a.grams);

  const cooking_methods = [...cookingBuckets.entries()]
    .map(([method, count]) => ({
      method,
      count,
      pct: cookingClassifiedN > 0 ? count / cookingClassifiedN : 0,
    }))
    .sort((a, b) => b.count - a.count);

  return {
    schema_version: 1,
    window_days: FOOD_QUALITY_WINDOW_DAYS,
    protein_sources,
    carb_sources,
    cooking_methods,
    diversity: {
      distinct_items: distinctNames.size,
      fish_meals_per_week: fishMealKeys.size / (FOOD_QUALITY_WINDOW_DAYS / 7),
      veg_servings_per_day: vegItemCount / FOOD_QUALITY_WINDOW_DAYS,
    },
    data_completeness: {
      protein_classified_pct:       proteinTotalG > 0 ? proteinClassifiedG / proteinTotalG : 0,
      carb_classified_pct:          carbTotalG    > 0 ? carbClassifiedG / carbTotalG       : 0,
      cooking_method_inferable_pct: rows.length   > 0 ? cookingClassifiedN / rows.length   : 0,
    },
    total_items: rows.length,
  };
}

/** USDA FDC top-level food category lives under one of these keys depending
 *  on dataType (foundation vs branded). Returns the description string. */
function extractUsdaCategory(raw: Record<string, unknown> | null): string | null {
  if (!raw) return null;
  const fc = (raw as { foodCategory?: unknown }).foodCategory;
  if (typeof fc === "string") return fc;
  if (fc && typeof fc === "object" && typeof (fc as { description?: unknown }).description === "string") {
    return (fc as { description: string }).description;
  }
  const branded = (raw as { brandedFoodCategory?: unknown }).brandedFoodCategory;
  if (typeof branded === "string") return branded;
  return null;
}

function shiftDays(d: string, days: number): string {
  const dt = new Date(`${d}T12:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
