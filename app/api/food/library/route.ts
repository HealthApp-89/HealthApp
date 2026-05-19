// app/api/food/library/route.ts
//
// GET ?slot=&q=&recent_days=30&frequent_days=30&section_limit=20
//   → { favorite_meals, favorite_items, recent, frequent, catalog? }
//
// Catalog renders ONLY when q != "".
// When q != "", dedupe across sections by lowercased name:
//   Favorites > Recent > Frequent > Catalog.

import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const QuerySchema = z.object({
  slot: z.enum(["breakfast", "lunch", "dinner", "snack"]).nullable().optional(),
  q: z.string().max(200).optional(),
  recent_days: z.coerce.number().int().min(1).max(180).default(30),
  frequent_days: z.coerce.number().int().min(1).max(180).default(30),
  section_limit: z.coerce.number().int().min(1).max(50).default(20),
});

const FAVORITE_MEAL_COLS = "id, eaten_at, meal_slot, items, totals, is_favorite";
const FAVORITE_ITEM_COLS = "id, user_id, name, qty_g, per_100g, source, db_ref, default_meal_slot, display_order, created_at";

export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({
    slot: url.searchParams.get("slot"),
    q: url.searchParams.get("q") ?? undefined,
    recent_days: url.searchParams.get("recent_days") ?? undefined,
    frequent_days: url.searchParams.get("frequent_days") ?? undefined,
    section_limit: url.searchParams.get("section_limit") ?? undefined,
  });
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

  const { slot, q, recent_days, frequent_days, section_limit } = parsed.data;
  const trimmedQ = q?.trim() ?? "";
  const hasQ = trimmedQ.length > 0;

  // Favorite meals — slot-aware ordering done client-side via a single query
  // sorted by eaten_at desc, then re-sort in JS to place matching slot first.
  const favMealsP = supabase
    .from("food_log_entries")
    .select(FAVORITE_MEAL_COLS)
    .eq("user_id", user.id)
    .eq("is_favorite", true)
    .eq("status", "committed")
    .order("eaten_at", { ascending: false })
    .limit(section_limit * 2);

  const favItemsP = supabase
    .from("food_item_favorites")
    .select(FAVORITE_ITEM_COLS)
    .eq("user_id", user.id)
    .order("display_order", { ascending: true })
    .order("created_at", { ascending: false })
    .limit(section_limit * 2);

  const recentP = supabase.rpc("food_recent_items", {
    p_user_id: user.id,
    p_days: recent_days,
    p_limit: section_limit,
  });
  const frequentP = supabase.rpc("food_frequent_items", {
    p_user_id: user.id,
    p_days: frequent_days,
    p_limit: section_limit,
  });
  const catalogP = hasQ
    ? supabase.rpc("food_cache_search", { q: trimmedQ, p_limit: section_limit })
    : Promise.resolve({ data: null, error: null } as const);

  const [favMealsRes, favItemsRes, recentRes, frequentRes, catalogRes] = await Promise.all([
    favMealsP, favItemsP, recentP, frequentP, catalogP,
  ]);

  if (favMealsRes.error) {
    console.error("[/api/food/library] fav_meals failed", favMealsRes.error);
    return NextResponse.json({ error: "fav_meals_failed" }, { status: 500 });
  }
  if (favItemsRes.error) {
    console.error("[/api/food/library] fav_items failed", favItemsRes.error);
    return NextResponse.json({ error: "fav_items_failed" }, { status: 500 });
  }
  if (recentRes.error) {
    console.error("[/api/food/library] recent failed", recentRes.error);
    return NextResponse.json({ error: "recent_failed" }, { status: 500 });
  }
  if (frequentRes.error) {
    console.error("[/api/food/library] frequent failed", frequentRes.error);
    return NextResponse.json({ error: "frequent_failed" }, { status: 500 });
  }
  if (catalogRes.error) {
    console.error("[/api/food/library] catalog failed", catalogRes.error);
    return NextResponse.json({ error: "catalog_failed" }, { status: 500 });
  }

  type FavMealRow = {
    id: string;
    eaten_at: string;
    meal_slot: "breakfast" | "lunch" | "dinner" | "snack";
    items: Array<{ name: string }>;
    totals: unknown;
    is_favorite: boolean;
  };
  type FavItemRow = {
    id: string;
    user_id: string;
    name: string;
    qty_g: number;
    per_100g: unknown;
    source: string;
    db_ref: unknown;
    default_meal_slot: "breakfast" | "lunch" | "dinner" | "snack" | null;
    display_order: number;
    created_at: string;
  };
  type RecentRow = { name: string; [k: string]: unknown };
  type FrequentRow = { name: string; [k: string]: unknown };
  type CatalogRow = { name: string; [k: string]: unknown };

  // Slot-priority re-sort.
  const favMeals = ((favMealsRes.data ?? []) as FavMealRow[])
    .slice()
    .sort((a, b) => {
      if (slot) {
        const aMatch = a.meal_slot === slot ? 0 : 1;
        const bMatch = b.meal_slot === slot ? 0 : 1;
        if (aMatch !== bMatch) return aMatch - bMatch;
      }
      return new Date(b.eaten_at).getTime() - new Date(a.eaten_at).getTime();
    })
    .slice(0, section_limit);

  const favItems = ((favItemsRes.data ?? []) as FavItemRow[])
    .slice()
    .sort((a, b) => {
      if (slot) {
        const aMatch = a.default_meal_slot === slot ? 0 : 1;
        const bMatch = b.default_meal_slot === slot ? 0 : 1;
        if (aMatch !== bMatch) return aMatch - bMatch;
      }
      if (a.display_order !== b.display_order) return a.display_order - b.display_order;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    })
    .slice(0, section_limit);

  const recent = (recentRes.data ?? []) as RecentRow[];
  const frequent = (frequentRes.data ?? []) as FrequentRow[];
  const catalog = hasQ ? ((catalogRes.data ?? []) as CatalogRow[]) : undefined;

  // Cross-section dedup ONLY when there's a query.
  if (hasQ) {
    const seen = new Set<string>();
    const note = (n: string) => { seen.add(n.toLowerCase()); };
    favMeals.forEach((m) => m.items.forEach((i) => note(i.name)));
    favItems.forEach((i) => note(i.name));
    const recentDeduped = recent.filter((r) => !seen.has(r.name.toLowerCase()));
    recentDeduped.forEach((r) => note(r.name));
    const frequentDeduped = frequent.filter((f) => !seen.has(f.name.toLowerCase()));
    frequentDeduped.forEach((f) => note(f.name));
    const catalogDeduped = (catalog ?? []).filter((c) => !seen.has(c.name.toLowerCase()));
    return NextResponse.json({
      favorite_meals: favMeals,
      favorite_items: favItems,
      recent: recentDeduped,
      frequent: frequentDeduped,
      catalog: catalogDeduped,
    });
  }

  return NextResponse.json({
    favorite_meals: favMeals,
    favorite_items: favItems,
    recent,
    frequent,
  });
}
