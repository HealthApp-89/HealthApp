// lib/food/types.ts
//
// Type shapes for the food logging feature. Mirrors the jsonb columns on
// food_log_entries + food_db_cache. Kept here (not in lib/data/types.ts)
// because they're narrowly used by lib/food/* and the food UI; the broader
// DailyLog types stay in lib/data/types.ts.

export type MealSlot = "breakfast" | "lunch" | "dinner" | "snack";

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
    source: "usda" | "openfoodfacts" | "manual" | "user_library";
    canonical_id: string;
  } | null;
  confidence: "high" | "medium" | "low" | null;
  /** Token-overlap score against the resolution query (0..1), or 1.0 for
   *  user-picked items, or null for LLM estimates and pre-existing rows.
   *  Drives the confidence chip in <DraftReview/>. */
  match_score: number | null;
};

export type FoodLogEntryKind = "text" | "barcode" | "photo" | "voice";
export type FoodLogEntryStatus = "draft" | "committed" | "rejected";

/** Result row from /api/food/search. Not yet persisted — canonical_id is
 *  null for fresh OFF/USDA hits until the user picks one (caching at pick
 *  time keeps the cache from accumulating rows the user never used). */
export type SearchCandidate = {
  name: string;
  per_100g: FoodMacros;
  source: "db" | "off" | "usda" | "user_library";
  canonical_id: string | null;
  image_url: string | null;
};

export type FoodLogEntryRawInput =
  | { kind: "text"; text: string }
  | { kind: "text"; source: "search"; items: SearchCandidate[]; qty_g: number[] }
  | { kind: "barcode"; upc: string; qty_g: number }
  | { kind: "photo"; photo_path: string }
  | { kind: "voice"; audio_path: string; transcript: string };

export type FoodLogEntry = {
  id: string;
  user_id: string;
  eaten_at: string;
  kind: FoodLogEntryKind;
  meal_slot: MealSlot;
  raw_input: FoodLogEntryRawInput;
  items: FoodItem[];
  totals: FoodMacros;
  is_estimated: boolean;
  is_favorite: boolean;
  status: FoodLogEntryStatus;
  created_at: string;
  updated_at: string;
  /** Back-reference to a user_food_items recipe row, when the entry was
   *  logged via a saved recipe. Migration 0028. NULL on every entry that
   *  wasn't sourced from a recipe; ON DELETE SET NULL so deleting the
   *  recipe row preserves the historical entry. */
  recipe_id?: string | null;
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

export type FoodItemFavorite = {
  id: string;
  user_id: string;
  name: string;
  qty_g: number;
  per_100g: FoodMacros;
  source: "db" | "llm";
  db_ref: { source: "usda" | "openfoodfacts" | "manual" | "user_library"; canonical_id: string } | null;
  default_meal_slot: MealSlot | null;
  display_order: number;
  created_at: string;
};

export type FoodRecentItem = {
  name: string;
  qty_g: number;
  per_100g: FoodMacros;
  source: "db" | "llm";
  db_ref: FoodItem["db_ref"];
  last_eaten_at: string;
  meal_slot: MealSlot;
};

export type FoodFrequentItem = {
  name: string;
  qty_g: number;
  per_100g: FoodMacros;
  source: "db" | "llm";
  db_ref: FoodItem["db_ref"];
  occurrence_count: number;
};

export type FoodLibrarySections = {
  favorite_meals: Array<Pick<FoodLogEntry, "id" | "eaten_at" | "meal_slot" | "items" | "totals"> & { is_favorite: true }>;
  favorite_items: FoodItemFavorite[];
  recent: FoodRecentItem[];
  frequent: FoodFrequentItem[];
  catalog?: FoodDbCacheRow[];
};

export type HistoryDay = {
  date: string;
  slots: Record<MealSlot, FoodLogEntry[]>;
};

// ── user_food_items (personal library) ────────────────────────────────────────

export type UserFoodItemSource = "user_manual" | "user_label" | "user_recipe";

/** Composite ingredient slot — what `composite_of[i]` looks like.
 *  Same shape as the resolver input: a name + qty in grams. At log-expand
 *  time each composite ingredient gets resolved through the standard chain. */
export type UserFoodComposite = {
  name: string;
  qty_g: number;
};

export type UserFoodItem = {
  id: string;
  user_id: string;
  name: string;
  /** Per-100g macros for single items. NULL for recipes. */
  per_100g: FoodMacros | null;
  /** Ingredient list for recipes. NULL for single items. */
  composite_of: UserFoodComposite[] | null;
  /** Recipe-only: typical "1 serving" gram weight; UI defaults the qty input
   *  to this when the user picks the recipe. NULL for single items. */
  default_serving_g: number | null;
  source: UserFoodItemSource;
  notes: string | null;
  created_at: string;
  updated_at: string;
};
