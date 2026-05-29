// lib/coach/nora-suggestions/compose-eating-identity.ts
//
// 90-day rollup. Reads food_log_entries (committed) + user_food_items
// (library + recipe expansion) + food_db_cache (USDA category for the
// category-classifier fallback). Returns EatingIdentity payload.

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  EatingIdentity,
  EatingIdentityTopItem,
  EatingIdentityCombo,
} from "@/lib/data/types";
import type { FoodItem, MealSlot } from "@/lib/food/types";
import { canonicalizeItemName } from "./canonicalize";
import {
  classifyProtein,
  classifyCarb,
  classifyCookingMethod,
} from "@/lib/coach/nutrition-intelligence/classify";

const WINDOW_DAYS = 90;
const MEAL_SLOTS: MealSlot[] = ["breakfast", "lunch", "dinner", "snack"];

type Entry = {
  eaten_at: string;
  meal_slot: MealSlot;
  items: FoodItem[] | null;
  recipe_id: string | null;
};

type Recipe = {
  id: string;
  name: string;
  composite_of: Array<{ name: string; qty_g: number }> | null;
  per_100g: FoodItem["per_100g"] | null;
};

export async function composeEatingIdentity(args: {
  supabase: SupabaseClient;
  userId: string;
  today: string;
}): Promise<EatingIdentity> {
  const { supabase, userId, today } = args;
  const windowStart = shiftDays(today, -WINDOW_DAYS);

  // 1. Fetch committed entries in window.
  const { data: rawEntries, error } = await supabase
    .from("food_log_entries")
    .select("eaten_at, meal_slot, items, recipe_id")
    .eq("user_id", userId)
    .eq("status", "committed")
    .gte("eaten_at", `${windowStart}T00:00:00Z`)
    .lte("eaten_at", `${today}T23:59:59Z`);
  if (error) throw error;
  const entries = (rawEntries as Entry[] | null) ?? [];

  // 2. Resolve library + recipe lookup table.
  const libraryIds = collectLibraryIds(entries);
  const libraryById = await fetchLibrary(supabase, userId, libraryIds);

  // 3. Resolve USDA categories for db items (uses food_db_cache).
  const canonicalIds = collectDbCanonicalIds(entries);
  const usdaCatByCanonical = await fetchUsdaCategories(supabase, canonicalIds);

  // 4. Build per-item rows: every counted "item" is either a recipe (atomic)
  //    or a single item (USDA / library single / llm). Recipes contribute one
  //    row to top_items and weighted component votes to category counts.
  const itemRows: ItemRow[] = [];
  for (const e of entries) {
    for (const it of e.items ?? []) {
      const ref = it.db_ref;
      const libId = ref?.source === "user_library" ? (ref.canonical_id as string) : null;
      const libRow = libId ? libraryById.get(libId) ?? null : null;

      // Recipe entry: counted atomically.
      if (libRow?.composite_of) {
        itemRows.push({
          kind: "recipe",
          canonical: canonicalizeItemName(libRow.name),
          variant: it.name,
          source: "user_library",
          library_item_id: libRow.id,
          qty_g: it.qty_g ?? 0,
          per_100g: libRow.per_100g ?? it.per_100g ?? defaultPer100g(),
          eaten_at: e.eaten_at,
          slot: e.meal_slot,
          components: libRow.composite_of,
        });
        continue;
      }

      // Single library / db / llm.
      const usdaCat = ref?.canonical_id ? usdaCatByCanonical.get(ref.canonical_id) ?? null : null;
      itemRows.push({
        kind: "single",
        canonical: canonicalizeItemName(libRow?.name ?? it.name),
        variant: it.name,
        source: libRow ? "user_library" : (it.source === "db" ? "db" : "llm"),
        library_item_id: libRow?.id,
        usda_category: usdaCat,
        qty_g: it.qty_g ?? 0,
        per_100g: libRow?.per_100g ?? it.per_100g ?? defaultPer100g(),
        eaten_at: e.eaten_at,
        slot: e.meal_slot,
      });
    }
  }

  // 5. Frequency-rank top items by canonical name.
  const byCanonical = new Map<string, ItemRow[]>();
  for (const r of itemRows) {
    const k = r.canonical;
    if (!byCanonical.has(k)) byCanonical.set(k, []);
    byCanonical.get(k)!.push(r);
  }
  const top_items: EatingIdentityTopItem[] = [...byCanonical.entries()]
    .map(([canonical, rows]): EatingIdentityTopItem => {
      const variants = [...new Set(rows.map((r) => r.variant))];
      const qty = rows.map((r) => r.qty_g).filter((q) => q > 0).sort((a, b) => a - b);
      const typical_qty_g = qty.length > 0 ? qty[Math.floor(qty.length / 2)] : 0;
      const slot_distribution: Record<MealSlot, number> = { breakfast: 0, lunch: 0, dinner: 0, snack: 0 };
      for (const r of rows) slot_distribution[r.slot]++;
      const last_logged = rows.map((r) => r.eaten_at).sort().slice(-1)[0]!.slice(0, 10);
      const head = rows[0];
      const base = {
        canonical_name: canonical,
        name_variants: variants,
        log_count: rows.length,
        typical_qty_g,
        macros_per_100g: head.per_100g,
        slot_distribution,
        last_logged,
      };
      // Discriminated union enforcement: library items MUST carry library_item_id.
      // INVARIANT: ItemRow construction only sets source="user_library" when libRow is
      // non-null, and libRow.id is always defined (SELECT'd from user_food_items.id).
      // The non-null assertion below is load-bearing — if a new ItemRow construction
      // path is added that violates this invariant, the `!` will throw at runtime.
      if (head.source === "user_library") {
        return { ...base, source: "user_library", library_item_id: head.library_item_id! };
      }
      return { ...base, source: head.source };
    })
    .sort((a, b) => b.log_count - a.log_count)
    .slice(0, 40);

  // 6. Category counts. For recipes: proportional votes per component.
  const proteinCounts = emptyRecord<ReturnType<typeof classifyProtein>["category"]>();
  const carbCounts = emptyRecord<ReturnType<typeof classifyCarb>["category"]>();
  const cookingCounts = emptyRecord<ReturnType<typeof classifyCookingMethod>["method"]>();
  for (const r of itemRows) {
    if (r.kind === "recipe" && r.components) {
      const totalQty = r.components.reduce((s, c) => s + (c.qty_g ?? 0), 0) || 1;
      for (const c of r.components) {
        const w = (c.qty_g ?? 0) / totalQty;
        const p = classifyProtein(c.name, null);
        proteinCounts[p.category] = (proteinCounts[p.category] ?? 0) + w;
        const cb = classifyCarb(c.name, null);
        carbCounts[cb.category] = (carbCounts[cb.category] ?? 0) + w;
        const cm = classifyCookingMethod(c.name);
        cookingCounts[cm.method] = (cookingCounts[cm.method] ?? 0) + w;
      }
    } else {
      const p = classifyProtein(r.variant, r.usda_category ?? null);
      proteinCounts[p.category] = (proteinCounts[p.category] ?? 0) + 1;
      const cb = classifyCarb(r.variant, r.usda_category ?? null);
      carbCounts[cb.category] = (carbCounts[cb.category] ?? 0) + 1;
      const cm = classifyCookingMethod(r.variant);
      cookingCounts[cm.method] = (cookingCounts[cm.method] ?? 0) + 1;
    }
  }

  // 7. Per-slot patterns. Group entries by (date, slot) using ±90min grouping.
  const meals = groupIntoMeals(entries, libraryById);
  const slot_patterns = computeSlotPatterns(meals);

  // 8. Frequent combos (pairs + trios) at meal granularity.
  const frequent_combos = computeCombos(meals).slice(0, 12);

  // 9. Monotone flags.
  const monotone_flags = computeMonotoneFlags(proteinCounts, carbCounts, meals);

  return {
    generated_on: today,
    window_days: 90,
    top_items,
    protein_category_counts: proteinCounts as EatingIdentity["protein_category_counts"],
    carb_category_counts: carbCounts as EatingIdentity["carb_category_counts"],
    cooking_method_counts: cookingCounts as EatingIdentity["cooking_method_counts"],
    slot_patterns,
    frequent_combos,
    monotone_flags,
  };
}

// ── Helpers ──

type ItemRow = {
  kind: "single" | "recipe";
  canonical: string;
  variant: string;
  source: "user_library" | "db" | "llm";
  library_item_id?: string;
  usda_category?: string | null;
  qty_g: number;
  per_100g: { kcal: number; protein_g: number; carbs_g: number; fat_g: number; fiber_g: number };
  eaten_at: string;
  slot: MealSlot;
  components?: Array<{ name: string; qty_g: number }>;
};

function shiftDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function defaultPer100g() {
  return { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 };
}

function collectLibraryIds(entries: Entry[]): string[] {
  const ids = new Set<string>();
  for (const e of entries) {
    if (e.recipe_id) ids.add(e.recipe_id);
    for (const it of e.items ?? []) {
      if (it.db_ref?.source === "user_library" && typeof it.db_ref.canonical_id === "string") {
        ids.add(it.db_ref.canonical_id);
      }
    }
  }
  return [...ids];
}

function collectDbCanonicalIds(entries: Entry[]): string[] {
  const ids = new Set<string>();
  for (const e of entries) {
    for (const it of e.items ?? []) {
      const ref = it.db_ref;
      if (ref && ref.source !== "user_library" && typeof ref.canonical_id === "string") {
        ids.add(ref.canonical_id);
      }
    }
  }
  return [...ids];
}

async function fetchLibrary(supabase: SupabaseClient, userId: string, ids: string[]): Promise<Map<string, Recipe>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await supabase
    .from("user_food_items")
    .select("id, name, composite_of, per_100g")
    .eq("user_id", userId)
    .in("id", ids);
  if (error) throw error;
  return new Map((data as Recipe[]).map((r) => [r.id, r]));
}

async function fetchUsdaCategories(supabase: SupabaseClient, canonicalIds: string[]): Promise<Map<string, string>> {
  if (canonicalIds.length === 0) return new Map();
  const { data, error } = await supabase
    .from("food_db_cache")
    .select("canonical_id, raw_payload")
    .in("canonical_id", canonicalIds);
  if (error) throw error;
  const m = new Map<string, string>();
  for (const r of (data as Array<{ canonical_id: string; raw_payload: Record<string, unknown> | null }>) ?? []) {
    const cat = (r.raw_payload as { foodCategory?: { description?: string } } | null)?.foodCategory?.description;
    if (typeof cat === "string") m.set(r.canonical_id, cat);
  }
  return m;
}

function emptyRecord<K extends string>(): Record<K, number> {
  return {} as Record<K, number>;
}

type Meal = {
  date: string;
  slot: MealSlot;
  items: Array<{ canonical: string; qty_g: number }>;
};

function groupIntoMeals(entries: Entry[], libraryById: Map<string, Recipe>): Meal[] {
  // Sort entries by eaten_at then group within (date, slot) with ±90min window.
  type E = Entry & { eaten_ts: number };
  const flat: E[] = entries.map((e) => ({ ...e, eaten_ts: Date.parse(e.eaten_at) }));
  flat.sort((a, b) => a.eaten_ts - b.eaten_ts);
  const meals: Meal[] = [];
  let bucket: { date: string; slot: MealSlot; ts: number; items: Array<{ canonical: string; qty_g: number }> } | null = null;
  for (const e of flat) {
    const date = e.eaten_at.slice(0, 10);
    const itemsCanon = (e.items ?? []).map((it) => {
      const libId = it.db_ref?.source === "user_library" ? (it.db_ref.canonical_id as string) : null;
      const libRow = libId ? libraryById.get(libId) : null;
      const name = libRow?.name ?? it.name;
      return { canonical: canonicalizeItemName(name), qty_g: it.qty_g ?? 0 };
    });
    if (bucket && bucket.date === date && bucket.slot === e.meal_slot && Math.abs(e.eaten_ts - bucket.ts) <= 90 * 60_000) {
      bucket.items.push(...itemsCanon);
      bucket.ts = e.eaten_ts;  // advance anchor — rolling 90min window, not fixed
    } else {
      if (bucket) meals.push({ date: bucket.date, slot: bucket.slot, items: bucket.items });
      bucket = { date, slot: e.meal_slot, ts: e.eaten_ts, items: [...itemsCanon] };
    }
  }
  if (bucket) meals.push({ date: bucket.date, slot: bucket.slot, items: bucket.items });
  return meals;
}

function computeSlotPatterns(meals: Meal[]): EatingIdentity["slot_patterns"] {
  // v1: typical_kcal_avg / typical_protein_g_avg are intentionally 0.
  // The suggestion engine's slot_fit factor falls back to slotTargets.kcal
  // (plan target) — so "slot shape" matches the plan rather than the
  // athlete's actual per-slot eating pattern. See spec §17 "v1 deviations".
  const out: EatingIdentity["slot_patterns"] = {
    breakfast: { typical_kcal_avg: 0, typical_protein_g_avg: 0, top_items: [] },
    lunch:     { typical_kcal_avg: 0, typical_protein_g_avg: 0, top_items: [] },
    dinner:    { typical_kcal_avg: 0, typical_protein_g_avg: 0, top_items: [] },
    snack:     { typical_kcal_avg: 0, typical_protein_g_avg: 0, top_items: [] },
  };
  for (const slot of MEAL_SLOTS) {
    const inSlot = meals.filter((m) => m.slot === slot);
    const itemCounts = new Map<string, number>();
    for (const m of inSlot) for (const i of m.items) itemCounts.set(i.canonical, (itemCounts.get(i.canonical) ?? 0) + 1);
    out[slot].top_items = [...itemCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k);
    // kcal/protein averages: leave at 0 for v1. The suggestion engine reads
    // slot_target from getTodayTargets which is the authoritative source for
    // per-slot kcal/protein targets. typical_*_avg here is for future use.
  }
  return out;
}

function computeCombos(meals: Meal[]): EatingIdentityCombo[] {
  const sigCounts = new Map<string, { items: string[]; count: number; last_seen: string; slots: MealSlot[] }>();
  for (const m of meals) {
    const sorted = [...new Set(m.items.map((i) => i.canonical))].filter((n) => n.length > 0).sort();
    if (sorted.length < 2) continue;
    // Pairs
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const key = [sorted[i], sorted[j]].join("|");
        bump(sigCounts, key, [sorted[i], sorted[j]], m.date, m.slot);
      }
    }
    // Trios
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        for (let k = j + 1; k < sorted.length; k++) {
          const key = [sorted[i], sorted[j], sorted[k]].join("|");
          bump(sigCounts, key, [sorted[i], sorted[j], sorted[k]], m.date, m.slot);
        }
      }
    }
  }
  return [...sigCounts.values()]
    .filter((c) => c.count >= 2)
    .map((c) => ({
      items: c.items,
      co_occurrence_count: c.count,
      last_seen: c.last_seen,
      avg_slot: mode(c.slots),
    }))
    .sort((a, b) => b.co_occurrence_count - a.co_occurrence_count);
}

function bump(
  m: Map<string, { items: string[]; count: number; last_seen: string; slots: MealSlot[] }>,
  key: string, items: string[], date: string, slot: MealSlot,
) {
  const cur = m.get(key);
  if (cur) {
    cur.count++;
    if (date > cur.last_seen) cur.last_seen = date;
    cur.slots.push(slot);
  } else {
    m.set(key, { items, count: 1, last_seen: date, slots: [slot] });
  }
}

function mode<T extends string>(xs: T[]): T {
  if (xs.length === 0) throw new Error("mode() called on empty array");
  const c = new Map<T, number>();
  for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function computeMonotoneFlags(
  proteinCounts: Record<string, number>,
  carbCounts: Record<string, number>,
  meals: Meal[],
): EatingIdentity["monotone_flags"] {
  const totalP = Object.values(proteinCounts).reduce((s, v) => s + v, 0) || 1;
  const totalC = Object.values(carbCounts).reduce((s, v) => s + v, 0) || 1;
  const topP = Math.max(0, ...Object.values(proteinCounts));
  const topC = Math.max(0, ...Object.values(carbCounts));
  const protein_top_share = totalP > 0 ? topP / totalP : 0;
  const carb_top_share = totalC > 0 ? topC / totalC : 0;

  // most_repeated_meal: the most-frequent canonical-item-set across meals.
  const mealSigCounts = new Map<string, { items: string[]; count: number }>();
  for (const m of meals) {
    const sorted = [...new Set(m.items.map((i) => i.canonical))].filter((n) => n.length > 0).sort();
    if (sorted.length < 1) continue;
    const key = sorted.join("|");
    const cur = mealSigCounts.get(key);
    if (cur) cur.count++;
    else mealSigCounts.set(key, { items: sorted, count: 1 });
  }
  const top = [...mealSigCounts.values()].sort((a, b) => b.count - a.count)[0];
  const most_repeated_meal = top && top.count >= 3 ? { items: top.items, count: top.count } : null;

  return { protein_top_share, carb_top_share, most_repeated_meal };
}
