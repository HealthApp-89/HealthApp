// lib/food/barcode.ts
//
// UPC → product macros via OpenFoodFacts (free, no key required).
//
// Cache-first: if food_db_cache has a row for (source='openfoodfacts', upc),
// return it. Otherwise fetch from OFF, normalize, write back, return.

import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import type { FoodDbCacheRow, FoodMacros } from "@/lib/food/types";

const OFF_BASE = "https://world.openfoodfacts.org/api/v2/product";

type OffNutriments = {
  "energy-kcal_100g"?: number;
  energy_100g?: number;          // kJ fallback when -kcal missing
  proteins_100g?: number;
  carbohydrates_100g?: number;
  fat_100g?: number;
  fiber_100g?: number;
};

type OffProduct = {
  product_name?: string;
  product_name_en?: string;
  brands?: string;
  image_front_url?: string;
  nutriments?: OffNutriments;
  serving_size?: string;          // e.g. "150 g"
  serving_quantity?: number;      // OFF's parsed numeric quantity
};

type OffResponse = {
  status: number;                 // 1 = found, 0 = not found
  product?: OffProduct;
};

function parseServingSizeG(prod: OffProduct): number | null {
  if (typeof prod.serving_quantity === "number") return prod.serving_quantity;
  if (!prod.serving_size) return null;
  const m = prod.serving_size.match(/(\d+(?:\.\d+)?)\s*g/i);
  return m ? parseFloat(m[1]) : null;
}

function normalizeMacros(n: OffNutriments | undefined): FoodMacros {
  const kcal = typeof n?.["energy-kcal_100g"] === "number"
    ? n["energy-kcal_100g"]
    : typeof n?.energy_100g === "number"
    ? n.energy_100g / 4.184              // kJ → kcal
    : 0;
  return {
    kcal,
    protein_g: n?.proteins_100g ?? 0,
    carbs_g:   n?.carbohydrates_100g ?? 0,
    fat_g:     n?.fat_100g ?? 0,
    fiber_g:   n?.fiber_100g ?? 0,
  };
}

/** Look up a UPC. Returns the cache row (always; freshly inserted if needed)
 *  or null when OFF has no record. */
export async function lookupBarcode(upc: string): Promise<FoodDbCacheRow | null> {
  const supabase = createSupabaseServiceRoleClient();

  // Cache hit?
  const { data: cached } = await supabase
    .from("food_db_cache")
    .select("*")
    .eq("source", "openfoodfacts")
    .eq("upc", upc)
    .maybeSingle();
  if (cached) return cached as FoodDbCacheRow;

  // Fetch from OFF (5s timeout to fail fast within Vercel's 10s budget).
  const url = `${OFF_BASE}/${encodeURIComponent(upc)}.json`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": "ApexHealthOS/1.0 (single-user app)" },
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.warn(`[food-barcode] OFF fetch failed for upc ${upc}`, err);
    return null;
  }
  if (!res.ok) {
    console.warn(`[food-barcode] OFF ${res.status} for upc ${upc}`);
    return null;
  }
  const data = (await res.json()) as OffResponse;
  if (data.status !== 1 || !data.product) return null;

  const name = data.product.product_name_en
    ?? data.product.product_name
    ?? `Unknown product ${upc}`;

  const { data: inserted, error } = await supabase
    .from("food_db_cache")
    .insert({
      source: "openfoodfacts",
      upc,
      name: data.product.brands ? `${name} (${data.product.brands})` : name,
      per_100g: normalizeMacros(data.product.nutriments),
      serving_size_g: parseServingSizeG(data.product),
      raw_payload: data.product,
    })
    .select("*")
    .single();
  if (error) {
    console.error("[food-barcode] cache insert failed", error);
    return null;
  }
  return inserted as FoodDbCacheRow;
}
