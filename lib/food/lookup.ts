// lib/food/lookup.ts
//
// resolveItemMacros: name + qty_g + userId → FoodItem
//
// Lookup chain:
//   1. user_food_items (personal library single-items via lookupLibraryByName)
//   2. food_db_cache trigram match on name (similarity ≥ TRGM_THRESHOLD)
//   3. USDA FoodData Central /foods/search (with British→US spelling fallback;
//      writes back to cache on success)
//   4. OpenFoodFacts text search (branded products USDA can't cover; writes
//      back to cache on success)
//   5. Haiku 4.5 estimates per_100g macros (NOT cached — only verified DB
//      sources go to cache)
//
// OFF was briefly removed from the text-resolve chain (v1.2 of meal-logging);
// restored here so Nora can resolve branded products without burning a
// web_search call. Cache write means subsequent lookups of the same brand
// skip OFF entirely.
//
// Returns a fully-populated FoodItem with macros scaled to qty_g.

import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { callClaude, parseClaudeJson } from "@/lib/anthropic/client";
import { SHORT_FORM_MODEL } from "@/lib/anthropic/models";
import { macrosForQty, type FoodItem, type FoodMacros, type FoodDbCacheRow } from "@/lib/food/types";
import { pickBestCandidate } from "@/lib/food/scoring";
import { maybeNormalize } from "@/lib/food/spelling";
import { lookupLibraryByName } from "@/lib/food/library";
import type { UserFoodItem } from "@/lib/food/types";

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

/** USDA nutrient numbers we care about.
 *
 *  Energy is a multi-code mess: SR Legacy foods use #208 ("Energy" in kcal),
 *  Foundation Foods use #1008 ("Energy" in kcal), and some Foundation rows
 *  ALSO publish Atwater-derived energy under #957 (general factors) and
 *  #958 (specific factors). Only checking #208 returns 0 for every
 *  Foundation Food (e.g. "Pineapple, raw", "Kiwifruit, raw"), poisoning the
 *  cache once they're looked up.
 *
 *  Strategy: walk the priority list and take the first nutrient with a
 *  finite positive value. Atwater Specific is the "best" real-world energy
 *  when present; fall back to the generic kcal codes; never fall back to
 *  kJ (would silently 4×-inflate). */
const ENERGY_KCAL_CODES = ["1008", "208", "958", "957"] as const;
const NUTRIENT_NUM = {
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
  const kcal = (() => {
    for (const num of ENERGY_KCAL_CODES) {
      const v = get(num);
      if (Number.isFinite(v) && v > 0) return v;
    }
    return 0;
  })();
  return {
    kcal,
    protein_g: get(NUTRIENT_NUM.protein_g),
    carbs_g:   get(NUTRIENT_NUM.carbs_g),
    fat_g:     get(NUTRIENT_NUM.fat_g),
    fiber_g:   get(NUTRIENT_NUM.fiber_g),
  };
}

/** Exported for the food_db_cache backfill script — re-extract kcal from
 *  raw_payload of cached USDA rows whose kcal=0 because the old extractor
 *  only checked nutrient #208. */
export function extractUsdaMacrosForBackfill(food: UsdaFood): FoodMacros {
  return extractUsdaMacros(food);
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

async function lookupUsda(name: string): Promise<{ row: FoodDbCacheRow; score: number } | null> {
  const apiKey = process.env.USDA_FDC_API_KEY;
  if (!apiKey) {
    console.warn("[food-lookup] USDA_FDC_API_KEY not set — skipping USDA");
    return null;
  }
  const doSearch = async (q: string): Promise<UsdaFood[] | null> => {
    const url = `${USDA_SEARCH_URL}?api_key=${encodeURIComponent(apiKey)}&query=${encodeURIComponent(q)}&pageSize=5&dataType=Foundation,SR%20Legacy`;
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    } catch (err) {
      console.warn(`[food-lookup] USDA fetch failed for query "${q}"`, err);
      return null;
    }
    if (!res.ok) {
      console.warn(`[food-lookup] USDA ${res.status} for query "${q}"`);
      return null;
    }
    const data = (await res.json()) as { foods?: UsdaFood[] };
    return data.foods ?? [];
  };

  // First try: literal query.
  let foods = await doSearch(name);
  let usedQuery = name;
  if (foods && foods.length === 0) {
    // Retry with a US-spelled variant if any British token maps.
    const variant = maybeNormalize(name);
    if (variant && variant !== name.toLowerCase()) {
      console.info(`[food-lookup] USDA 0 hits for "${name}" — retrying as "${variant}"`);
      const retried = await doSearch(variant);
      if (retried) {
        foods = retried;
        usedQuery = variant;
      }
    }
  }
  if (!foods || foods.length === 0) return null;

  const best = pickBestCandidate(
    usedQuery,
    foods.map((f) => ({ name: f.description, food: f })),
    0.5,
  );
  if (!best) {
    console.info(`[food-lookup] USDA top-${foods.length} all below threshold for "${name}"`);
    return null;
  }
  const top = best.candidate.food;
  const per_100g = extractUsdaMacros(top);

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
  return { row: inserted as FoodDbCacheRow, score: best.score };
}

const OFF_SEARCH_URL = "https://world.openfoodfacts.org/cgi/search.pl";

type OffSearchProduct = {
  product_name?: string;
  product_name_en?: string;
  brands?: string;
  nutriments?: {
    "energy-kcal_100g"?: number;
    energy_100g?: number;
    proteins_100g?: number;
    carbohydrates_100g?: number;
    fat_100g?: number;
    fiber_100g?: number;
  };
  code?: string;
  image_thumb_url?: string;
};

type OffSearchResponse = {
  products?: OffSearchProduct[];
};

/** OpenFoodFacts text search. Used as a 2nd-tier lookup between USDA and the
 *  LLM estimate in resolveItemMacros, and also called by /api/food/search.
 *  Returns the chosen cached row + score, or null on miss / no-score. */
export async function lookupOpenFoodFacts(name: string): Promise<{ row: FoodDbCacheRow; score: number } | null> {
  const url = `${OFF_SEARCH_URL}?search_terms=${encodeURIComponent(name)}&json=1&page_size=5&fields=product_name,product_name_en,brands,nutriments,code,image_thumb_url`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": "ApexHealthOS/1.0 (single-user app)" },
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.warn(`[food-lookup] OFF fetch failed for "${name}"`, err);
    return null;
  }
  if (!res.ok) {
    console.warn(`[food-lookup] OFF ${res.status} for "${name}"`);
    return null;
  }
  const data = (await res.json()) as OffSearchResponse;
  const products = data.products ?? [];
  if (products.length === 0) return null;

  // Build candidate list with display names. Skip products without names or macros.
  const candidates = products
    .map((p) => {
      const displayName = p.product_name_en ?? p.product_name;
      if (!displayName) return null;
      const n = p.nutriments;
      const kcal = typeof n?.["energy-kcal_100g"] === "number"
        ? n["energy-kcal_100g"]
        : typeof n?.energy_100g === "number"
        ? n.energy_100g / 4.184
        : null;
      if (kcal === null) return null;  // No macros → skip
      return {
        name: p.brands ? `${displayName} (${p.brands})` : displayName,
        product: p,
        per_100g: {
          kcal,
          protein_g: n?.proteins_100g ?? 0,
          carbs_g: n?.carbohydrates_100g ?? 0,
          fat_g: n?.fat_100g ?? 0,
          fiber_g: n?.fiber_100g ?? 0,
        },
      };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);
  if (candidates.length === 0) return null;

  const best = pickBestCandidate(name, candidates, 0.5);
  if (!best) {
    console.info(`[food-lookup] OFF top-${candidates.length} all below threshold for "${name}"`);
    return null;
  }

  const supabase = createSupabaseServiceRoleClient();
  const { data: inserted, error } = await supabase
    .from("food_db_cache")
    .insert({
      source: "openfoodfacts",
      upc: null,  // Text-search hits aren't keyed by UPC
      name: best.candidate.name,
      per_100g: best.candidate.per_100g,
      serving_size_g: null,
      raw_payload: best.candidate.product,
    })
    .select("*")
    .single();
  if (error) {
    console.error("[food-lookup] OFF cache insert failed", error);
    return null;
  }
  return { row: inserted as FoodDbCacheRow, score: best.score };
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

export async function resolveItemMacros(
  name: string,
  qty_g: number,
  userId: string,
): Promise<FoodItem> {
  // 1. user_food_items (library — single items only at this layer; recipes
  //    are expanded by the caller via expandLibraryRecipe, not here).
  const lib = await lookupLibraryByName(userId, name);
  if (lib && lib.per_100g) {
    const macros = macrosForQty(lib.per_100g, qty_g);
    return {
      name: lib.name,
      qty_g,
      ...macros,
      per_100g: lib.per_100g,
      source: "db",
      db_ref: { source: "user_library", canonical_id: lib.id },
      confidence: "high",
      match_score: 1.0,
    };
  }

  // 2. food_db_cache
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
      match_score: 1.0,
    };
  }

  // 3. USDA (with spelling fallback inside lookupUsda)
  const usda = await lookupUsda(name);
  if (usda) {
    const macros = macrosForQty(usda.row.per_100g, qty_g);
    return {
      name: usda.row.name,
      qty_g,
      ...macros,
      per_100g: usda.row.per_100g,
      source: "db",
      db_ref: { source: "usda", canonical_id: usda.row.canonical_id },
      confidence: usda.score >= 0.7 ? "high" : "medium",
      match_score: usda.score,
    };
  }

  // 4. OpenFoodFacts — branded products USDA doesn't cover. Cache write on hit
  //    means future lookups of the same brand short-circuit at step 2.
  const off = await lookupOpenFoodFacts(name);
  if (off) {
    const macros = macrosForQty(off.row.per_100g, qty_g);
    return {
      name: off.row.name,
      qty_g,
      ...macros,
      per_100g: off.row.per_100g,
      source: "db",
      db_ref: { source: "openfoodfacts", canonical_id: off.row.canonical_id },
      confidence: off.score >= 0.7 ? "high" : "medium",
      match_score: off.score,
    };
  }

  // 5. LLM fallback (unchanged) — confidence='low', is_estimated=true.
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

/** Expand a recipe library row into its component items, resolving each via
 *  the standard chain. Returns the resolved FoodItem[] sized to `qty_g`
 *  relative to the recipe's default_serving_g (or 1× if no default). */
export async function expandLibraryRecipe(
  recipe: UserFoodItem,
  qty_g: number,
  userId: string,
): Promise<FoodItem[]> {
  if (!recipe.composite_of || !recipe.default_serving_g) {
    throw new Error(`expandLibraryRecipe: ${recipe.id} is not a recipe`);
  }
  const scale = qty_g / recipe.default_serving_g;
  return Promise.all(
    recipe.composite_of.map((ing) =>
      resolveItemMacros(ing.name, ing.qty_g * scale, userId),
    ),
  );
}
