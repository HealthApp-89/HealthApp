// lib/food/search.ts
//
// Multi-source food search used by /api/food/search and the SEARCH tab's
// FoodSearchPicker. Fanout in parallel:
//   1. food_db_cache substring match via ilike
//   2. OpenFoodFacts cgi/search.pl
//   3. USDA /foods/search
//
// Merge + dedupe (case-insensitive name match), sort by source preference
// (db > off > usda) then by token-overlap score. Return top 20.
//
// TODO: cache lookup uses ilike substring not trigram similarity — misses
// plurals ("eggs" → cache "Egg"). Trade-off acknowledged: OFF/USDA will
// surface the canonical form anyway since we always fan out (no short-
// circuit). Migrate to a pg_trgm RPC if recall becomes a real problem.
//
// CACHE WRITE-BACK happens at PICK TIME (/api/food/draft), NOT during search,
// to keep search idempotent and avoid polluting the cache with rows the user
// never used.

import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { scoreOverlap } from "@/lib/food/scoring";
import type { FoodMacros, FoodDbCacheRow, SearchCandidate } from "@/lib/food/types";

const USDA_SEARCH_URL = "https://api.nal.usda.gov/fdc/v1/foods/search";
const OFF_SEARCH_URL = "https://world.openfoodfacts.org/cgi/search.pl";

const SOURCE_RANK = { user_library: 0, db: 1, usda: 2, off: 3 } as const;

async function searchUserLibrary(query: string, userId: string): Promise<SearchCandidate[]> {
  // Inline service-role read so searchFoods stays self-contained. Recipes
  // (per_100g is null) get a synthetic 0-macro stub so the picker can still
  // surface them by name; the sheet resolves recipe vs item at append time.
  const supabase = createSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .from("user_food_items")
    .select("id, name, per_100g, composite_of, default_serving_g")
    .eq("user_id", userId)
    .ilike("name", `%${query}%`)
    .order("updated_at", { ascending: false })
    .limit(20);
  if (error || !data) return [];
  return (data as Array<{
    id: string;
    name: string;
    per_100g: FoodMacros | null;
    composite_of: unknown[] | null;
    default_serving_g: number | null;
  }>).map((r) => {
    // Defensive field-by-field merge. r.per_100g is a jsonb column; older
    // user_food_items rows can be missing fiber_g entirely, and recipes carry
    // null. Field defaults to 0 in either case so the candidate passes the
    // /api/food/draft Zod schema (which requires all five macros).
    const raw = (r.per_100g ?? {}) as Partial<FoodMacros>;
    const per_100g: FoodMacros = {
      kcal: typeof raw.kcal === "number" ? raw.kcal : 0,
      protein_g: typeof raw.protein_g === "number" ? raw.protein_g : 0,
      carbs_g: typeof raw.carbs_g === "number" ? raw.carbs_g : 0,
      fat_g: typeof raw.fat_g === "number" ? raw.fat_g : 0,
      fiber_g: typeof raw.fiber_g === "number" ? raw.fiber_g : 0,
    };
    return {
      name: r.name,
      per_100g,
      source: "user_library" as const,
      canonical_id: r.id,
      image_url: null,
    };
  });
}

async function searchCacheTrigram(query: string): Promise<SearchCandidate[]> {
  const supabase = createSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .from("food_db_cache")
    .select("*")
    .ilike("name", `%${query}%`)
    .limit(20);
  if (error || !data) return [];
  return (data as FoodDbCacheRow[]).map((row) => ({
    name: row.name,
    per_100g: row.per_100g,
    source: "db" as const,
    canonical_id: row.canonical_id,
    image_url: null,
  }));
}

async function searchOpenFoodFacts(query: string): Promise<SearchCandidate[]> {
  const url = `${OFF_SEARCH_URL}?search_terms=${encodeURIComponent(query)}&json=1&page_size=10&fields=product_name,product_name_en,brands,nutriments,code,image_thumb_url`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": "ApexHealthOS/1.0 (single-user app)" },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return [];
  }
  if (!res.ok) return [];
  const data = (await res.json()) as {
    products?: Array<{
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
      image_thumb_url?: string;
    }>;
  };
  const products = data.products ?? [];
  return products
    .map((p): SearchCandidate | null => {
      const displayName = p.product_name_en ?? p.product_name;
      if (!displayName) return null;
      const n = p.nutriments;
      const kcal = typeof n?.["energy-kcal_100g"] === "number"
        ? n["energy-kcal_100g"]
        : typeof n?.energy_100g === "number"
        ? n.energy_100g / 4.184
        : null;
      if (kcal === null) return null;
      const per_100g: FoodMacros = {
        kcal,
        protein_g: n?.proteins_100g ?? 0,
        carbs_g: n?.carbohydrates_100g ?? 0,
        fat_g: n?.fat_100g ?? 0,
        fiber_g: n?.fiber_100g ?? 0,
      };
      return {
        name: p.brands ? `${displayName} (${p.brands})` : displayName,
        per_100g,
        source: "off",
        canonical_id: null,
        image_url: p.image_thumb_url ?? null,
      };
    })
    .filter((c): c is SearchCandidate => c !== null);
}

async function searchUsda(query: string): Promise<SearchCandidate[]> {
  const apiKey = process.env.USDA_FDC_API_KEY;
  if (!apiKey) return [];
  const url = `${USDA_SEARCH_URL}?api_key=${encodeURIComponent(apiKey)}&query=${encodeURIComponent(query)}&pageSize=10&dataType=Foundation,SR%20Legacy`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  } catch {
    return [];
  }
  if (!res.ok) return [];
  const data = (await res.json()) as {
    foods?: Array<{
      description: string;
      foodNutrients?: Array<{ nutrientNumber?: string; value?: number }>;
    }>;
  };
  const foods = data.foods ?? [];
  return foods.map((f): SearchCandidate => {
    const get = (num: string): number => {
      const n = f.foodNutrients?.find((x) => x.nutrientNumber === num);
      return typeof n?.value === "number" ? n.value : 0;
    };
    return {
      name: f.description,
      per_100g: {
        kcal:      get("208"),
        protein_g: get("203"),
        carbs_g:   get("205"),
        fat_g:     get("204"),
        fiber_g:   get("291"),
      },
      source: "usda",
      canonical_id: null,
      image_url: null,
    };
  });
}

export async function searchFoods(
  query: string,
  userId: string,
  limit = 20,
): Promise<SearchCandidate[]> {
  if (query.trim().length < 2) return [];

  // Always fan out to all sources. A previous version short-circuited on a
  // high cache score, but that meant a single bad past pick (e.g. "Oil, corn,
  // peanut, and olive" from the broken pre-scoring USDA path) could poison
  // every future search for "olive oil" by hiding fresh OFF/USDA candidates.
  // Latency cost ≈ 500ms parallel; acceptable for an active-typing search.
  const [libHits, cacheHits, offHits, usdaHits] = await Promise.all([
    searchUserLibrary(query, userId),
    searchCacheTrigram(query),
    searchOpenFoodFacts(query),
    searchUsda(query),
  ]);
  const all = [...libHits, ...cacheHits, ...offHits, ...usdaHits];

  // Dedupe by case-insensitive name with whitespace collapsed. Keep first
  // occurrence — array order favours db > off > usda which matches the
  // SOURCE_RANK preference applied below.
  const seen = new Set<string>();
  const deduped: SearchCandidate[] = [];
  for (const c of all) {
    const key = c.name.toLowerCase().replace(/\s+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(c);
  }

  // Sort: source rank first, then score desc.
  deduped.sort((a, b) => {
    const ra = SOURCE_RANK[a.source];
    const rb = SOURCE_RANK[b.source];
    if (ra !== rb) return ra - rb;
    return scoreOverlap(query, b.name) - scoreOverlap(query, a.name);
  });

  return deduped.slice(0, limit);
}
