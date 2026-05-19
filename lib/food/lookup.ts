// lib/food/lookup.ts
//
// resolveItemMacros: name + qty_g → FoodItem
//
// Lookup chain:
//   1. food_db_cache trigram match on name (similarity ≥ TRGM_THRESHOLD)
//   2. USDA FoodData Central /foods/search (writes back to cache on success)
//   3. Haiku 4.5 estimates per_100g macros (NOT cached — only verified DB
//      sources go to cache)
//
// Returns a fully-populated FoodItem with macros scaled to qty_g.

import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { callClaude, parseClaudeJson } from "@/lib/anthropic/client";
import { SHORT_FORM_MODEL } from "@/lib/anthropic/models";
import { macrosForQty, type FoodItem, type FoodMacros, type FoodDbCacheRow } from "@/lib/food/types";

/** Minimum trigram similarity for a cache match to count. Tune during use. */
const TRGM_THRESHOLD = 0.6;

/** USDA FDC search endpoint. Returns Foundation + SR Legacy + Survey foods
 *  by default — the canonical "raw ingredients" datasets. */
const USDA_SEARCH_URL = "https://api.nal.usda.gov/fdc/v1/foods/search";

type UsdaFood = {
  fdcId: number;
  description: string;
  foodNutrients?: Array<{
    nutrientId?: number;
    nutrientName?: string;
    nutrientNumber?: string;
    value?: number;
    unitName?: string;
  }>;
  servingSize?: number;
  servingSizeUnit?: string;
};

/** USDA nutrient numbers we care about. */
const NUTRIENT_NUM = {
  energy_kcal: "208",
  protein_g:   "203",
  carbs_g:     "205",
  fat_g:       "204",
  fiber_g:     "291",
} as const;

function extractUsdaMacros(food: UsdaFood): FoodMacros {
  const get = (num: string): number => {
    const n = food.foodNutrients?.find((x) => x.nutrientNumber === num);
    return typeof n?.value === "number" ? n.value : 0;
  };
  return {
    kcal:      get(NUTRIENT_NUM.energy_kcal),
    protein_g: get(NUTRIENT_NUM.protein_g),
    carbs_g:   get(NUTRIENT_NUM.carbs_g),
    fat_g:     get(NUTRIENT_NUM.fat_g),
    fiber_g:   get(NUTRIENT_NUM.fiber_g),
  };
}

async function lookupCacheByName(name: string): Promise<FoodDbCacheRow | null> {
  const supabase = createSupabaseServiceRoleClient();
  // Use pg_trgm similarity. Order by similarity desc, limit 1.
  // NB: the RPC returns a composite of food_db_cache. When no row qualifies
  // it returns a single tuple-of-nulls (not "no rows"), so maybeSingle()
  // resolves to a non-null object whose fields are all null. We must check
  // the primary-key column to distinguish a real hit from a null-row sentinel.
  const { data, error } = await supabase
    .rpc("food_cache_similar", { q: name, threshold: TRGM_THRESHOLD })
    .maybeSingle();
  if (error) {
    // If the RPC doesn't exist (didn't ship in 0018), fall back to ilike.
    const fallback = await supabase
      .from("food_db_cache")
      .select("*")
      .ilike("name", `%${name}%`)
      .limit(1)
      .maybeSingle();
    if (fallback.error) return null;
    const row = fallback.data as FoodDbCacheRow | null;
    return row && row.canonical_id ? row : null;
  }
  const row = data as FoodDbCacheRow | null;
  return row && row.canonical_id ? row : null;
}

async function lookupUsda(name: string): Promise<FoodDbCacheRow | null> {
  const apiKey = process.env.USDA_FDC_API_KEY;
  if (!apiKey) {
    console.warn("[food-lookup] USDA_FDC_API_KEY not set — skipping USDA");
    return null;
  }
  const url = `${USDA_SEARCH_URL}?api_key=${encodeURIComponent(apiKey)}&query=${encodeURIComponent(name)}&pageSize=1&dataType=Foundation,SR%20Legacy`;
  let res: Response;
  try {
    // 5s timeout — Vercel functions have a 10s budget; we must fail fast and
    // fall through to the LLM rather than wedge the whole request.
    res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  } catch (err) {
    console.warn(`[food-lookup] USDA fetch failed for query "${name}"`, err);
    return null;
  }
  if (!res.ok) {
    console.warn(`[food-lookup] USDA ${res.status} for query "${name}"`);
    return null;
  }
  const data = (await res.json()) as { foods?: UsdaFood[] };
  const top = data.foods?.[0];
  if (!top) return null;

  const per_100g = extractUsdaMacros(top);
  // USDA Foundation/SR Legacy values are per 100g for energy/macros.

  const supabase = createSupabaseServiceRoleClient();
  const { data: inserted, error } = await supabase
    .from("food_db_cache")
    .insert({
      source: "usda",
      upc: null,
      name: top.description,
      per_100g,
      serving_size_g: top.servingSizeUnit === "g" ? top.servingSize : null,
      raw_payload: top,
    })
    .select("*")
    .single();
  if (error) {
    console.error("[food-lookup] cache insert failed", error);
    return null;
  }
  return inserted as FoodDbCacheRow;
}

async function llmEstimate(name: string): Promise<FoodMacros> {
  const prompt = `You are a nutrition reference. Return per-100g macros for the food described below as STRICT JSON, no commentary.

Schema: {"kcal": number, "protein_g": number, "carbs_g": number, "fat_g": number, "fiber_g": number}

Food: "${name}"

If the food is ambiguous, pick the most common prepared form.`;
  const raw = await callClaude([{ role: "user", content: prompt }], {
    model: SHORT_FORM_MODEL,
    maxTokens: 200,
    temperature: 0,
  });
  return parseClaudeJson<FoodMacros>(raw);
}

export async function resolveItemMacros(name: string, qty_g: number): Promise<FoodItem> {
  // 1. cache
  const cached = await lookupCacheByName(name);
  if (cached) {
    const macros = macrosForQty(cached.per_100g, qty_g);
    return {
      name: cached.name,
      qty_g,
      ...macros,
      per_100g: cached.per_100g,
      source: "db",
      db_ref: { source: cached.source, canonical_id: cached.canonical_id },
      confidence: "high",
      match_score: null,
    };
  }
  // 2. USDA
  const usda = await lookupUsda(name);
  if (usda) {
    const macros = macrosForQty(usda.per_100g, qty_g);
    return {
      name: usda.name,
      qty_g,
      ...macros,
      per_100g: usda.per_100g,
      source: "db",
      db_ref: { source: "usda", canonical_id: usda.canonical_id },
      confidence: "high",
      match_score: null,
    };
  }
  // 3. LLM fallback — wrap so route handlers get a typed error instead of an
  //    uncaught Anthropic-API or JSON-parse exception bubbling up as a 500.
  let per_100g: FoodMacros;
  try {
    per_100g = await llmEstimate(name);
  } catch (err) {
    console.warn("[food-lookup] LLM estimate failed", err);
    throw new Error(`resolveItemMacros: all lookup paths failed for "${name}"`);
  }
  const macros = macrosForQty(per_100g, qty_g);
  return {
    name,
    qty_g,
    ...macros,
    per_100g,
    source: "llm",
    db_ref: null,
    confidence: "low",
    match_score: null,
  };
}
