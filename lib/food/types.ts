// lib/food/types.ts
//
// Type shapes for the food logging feature. Mirrors the jsonb columns on
// food_log_entries + food_db_cache. Kept here (not in lib/data/types.ts)
// because they're narrowly used by lib/food/* and the food UI; the broader
// DailyLog types stay in lib/data/types.ts.

export type FoodMacros = {
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
};

export type FoodItem = {
  name: string;
  qty_g: number;
  /** Macros at qty_g (computed: per_100g × qty_g / 100). */
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
  /** Per-100g values — kept on the item so client-side qty rescale doesn't need a round-trip. */
  per_100g: FoodMacros;
  source: "db" | "llm";
  db_ref: {
    source: "usda" | "openfoodfacts" | "manual";
    canonical_id: string;
  } | null;
  confidence: "high" | "medium" | "low" | null;
};

export type FoodLogEntryKind = "text" | "barcode" | "photo" | "voice";
export type FoodLogEntryStatus = "draft" | "committed" | "rejected";

export type FoodLogEntryRawInput =
  | { kind: "text"; text: string }
  | { kind: "barcode"; upc: string; qty_g: number }
  | { kind: "photo"; photo_path: string }
  | { kind: "voice"; audio_path: string; transcript: string };

export type FoodLogEntry = {
  id: string;
  user_id: string;
  eaten_at: string;
  kind: FoodLogEntryKind;
  raw_input: FoodLogEntryRawInput;
  items: FoodItem[];
  totals: FoodMacros;
  is_estimated: boolean;
  status: FoodLogEntryStatus;
  created_at: string;
  updated_at: string;
};

export type FoodDbCacheRow = {
  canonical_id: string;
  source: "usda" | "openfoodfacts" | "manual";
  upc: string | null;
  name: string;
  per_100g: FoodMacros;
  serving_size_g: number | null;
  raw_payload: unknown;
  last_fetched_at: string;
};

/** Default macros object — used as zero for sums/initializations. */
export const ZERO_MACROS: FoodMacros = {
  kcal: 0,
  protein_g: 0,
  carbs_g: 0,
  fat_g: 0,
  fiber_g: 0,
};

export function sumMacros(items: Array<{ kcal: number; protein_g: number; carbs_g: number; fat_g: number; fiber_g: number }>): FoodMacros {
  return items.reduce<FoodMacros>(
    (acc, it) => ({
      kcal:      acc.kcal      + it.kcal,
      protein_g: acc.protein_g + it.protein_g,
      carbs_g:   acc.carbs_g   + it.carbs_g,
      fat_g:     acc.fat_g     + it.fat_g,
      fiber_g:   acc.fiber_g   + it.fiber_g,
    }),
    { ...ZERO_MACROS },
  );
}

/** Scale per-100g macros to a given qty in grams. */
export function macrosForQty(per_100g: FoodMacros, qty_g: number): FoodMacros {
  const k = qty_g / 100;
  return {
    kcal:      per_100g.kcal      * k,
    protein_g: per_100g.protein_g * k,
    carbs_g:   per_100g.carbs_g   * k,
    fat_g:     per_100g.fat_g     * k,
    fiber_g:   per_100g.fiber_g   * k,
  };
}
