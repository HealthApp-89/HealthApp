// app/api/food/library/draft/route.ts
//
// POST → create a draft food_log_entries row from any library source.
// Supports six source_kinds. Body validates that exactly one of
// {source_id, item, items} is populated.

import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { macrosForQty, sumMacros } from "@/lib/food/types";
import type { FoodItem, FoodMacros } from "@/lib/food/types";

const MacrosSchema = z.object({
  kcal: z.number().nonnegative(),
  protein_g: z.number().nonnegative(),
  carbs_g: z.number().nonnegative(),
  fat_g: z.number().nonnegative(),
  fiber_g: z.number().nonnegative(),
});

const DbRefSchema = z
  .object({
    source: z.enum(["usda", "openfoodfacts", "manual"]),
    canonical_id: z.string().uuid(),
  })
  .nullable()
  .optional();

const ItemSchema = z.object({
  name: z.string(),
  qty_g: z.number().positive().finite(),
  kcal: z.number().nonnegative(),
  protein_g: z.number().nonnegative(),
  carbs_g: z.number().nonnegative(),
  fat_g: z.number().nonnegative(),
  fiber_g: z.number().nonnegative(),
  per_100g: MacrosSchema,
  source: z.enum(["db", "llm"]),
  db_ref: DbRefSchema,
  confidence: z.enum(["high", "medium", "low"]).nullable().optional(),
});

const BodySchema = z.object({
  source_kind: z.enum(["favorite_meal", "favorite_item", "recent", "frequent", "catalog", "history_picker"]),
  source_id: z.string().uuid().optional(),
  item: ItemSchema.optional(),
  items: z.array(ItemSchema).min(1).optional(),
  source_entry_ids: z.array(z.string().uuid()).optional(),
  meal_slot: z.enum(["breakfast", "lunch", "dinner", "snack"]),
  eaten_at: z.string().datetime().optional(),
  qty_g: z.number().positive().finite().optional(),
});

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const json = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

  const body = parsed.data;
  const provided = [body.source_id, body.item, body.items].filter((v) => v !== undefined).length;
  if (provided !== 1) {
    return NextResponse.json({ error: "exactly_one_of_source_id_item_items_required" }, { status: 400 });
  }

  let items: FoodItem[];
  if (body.source_kind === "favorite_meal") {
    if (!body.source_id) return NextResponse.json({ error: "source_id_required" }, { status: 400 });
    const { data: src } = await supabase
      .from("food_log_entries")
      .select("items")
      .eq("id", body.source_id)
      .eq("user_id", user.id)
      .eq("is_favorite", true)
      .maybeSingle();
    if (!src) return NextResponse.json({ error: "favorite_meal_not_found" }, { status: 404 });
    items = src.items as FoodItem[];
  } else if (body.source_kind === "favorite_item") {
    if (!body.source_id) return NextResponse.json({ error: "source_id_required" }, { status: 400 });
    const { data: fav } = await supabase
      .from("food_item_favorites")
      .select("name, qty_g, per_100g, source, db_ref")
      .eq("id", body.source_id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!fav) return NextResponse.json({ error: "favorite_item_not_found" }, { status: 404 });
    const qty = body.qty_g ?? Number(fav.qty_g);
    const macros = macrosForQty(fav.per_100g as FoodMacros, qty);
    items = [{
      name: fav.name,
      qty_g: qty,
      ...macros,
      per_100g: fav.per_100g as FoodMacros,
      source: fav.source as "db" | "llm",
      db_ref: fav.db_ref as FoodItem["db_ref"],
      confidence: "high",
      match_score: null,
    }];
  } else if (body.source_kind === "catalog") {
    if (!body.source_id) return NextResponse.json({ error: "source_id_required" }, { status: 400 });
    const { data: cache } = await supabase
      .from("food_db_cache")
      .select("canonical_id, source, name, per_100g, serving_size_g")
      .eq("canonical_id", body.source_id)
      .maybeSingle();
    if (!cache) return NextResponse.json({ error: "catalog_row_not_found" }, { status: 404 });
    const qty = body.qty_g ?? Number(cache.serving_size_g ?? 100);
    const macros = macrosForQty(cache.per_100g as FoodMacros, qty);
    items = [{
      name: cache.name,
      qty_g: qty,
      ...macros,
      per_100g: cache.per_100g as FoodMacros,
      source: "db",
      db_ref: {
        source: cache.source as "usda" | "openfoodfacts" | "manual",
        canonical_id: cache.canonical_id,
      },
      confidence: "high",
      match_score: null,
    }];
  } else if (body.source_kind === "recent" || body.source_kind === "frequent") {
    if (!body.item) return NextResponse.json({ error: "item_required" }, { status: 400 });
    const qty = body.qty_g ?? body.item.qty_g;
    const macros = macrosForQty(body.item.per_100g, qty);
    items = [{
      ...body.item,
      qty_g: qty,
      ...macros,
      confidence: body.item.confidence ?? "high",
      db_ref: body.item.db_ref ?? null,
    } as FoodItem];
  } else {
    // history_picker
    if (!body.items) return NextResponse.json({ error: "items_required" }, { status: 400 });
    items = body.items.map((i) => ({
      ...i,
      confidence: i.confidence ?? "high",
      db_ref: i.db_ref ?? null,
    } as FoodItem));
  }

  const totals = sumMacros(items);
  const is_estimated = items.some((it) => it.source === "llm");

  const rawInput: Record<string, unknown> = {
    kind: "library",
    source_kind: body.source_kind,
  };
  if (body.source_id) rawInput.source_id = body.source_id;
  if (body.source_entry_ids) rawInput.source_entry_ids = body.source_entry_ids;

  const { data: inserted, error } = await supabase
    .from("food_log_entries")
    .insert({
      user_id: user.id,
      eaten_at: body.eaten_at ?? new Date().toISOString(),
      meal_slot: body.meal_slot,
      kind: "library",
      raw_input: rawInput,
      items,
      totals,
      is_estimated,
      is_favorite: false,
      status: "draft",
    })
    .select("id, eaten_at, meal_slot, kind, items, totals, is_estimated, is_favorite, status")
    .single();
  if (error) {
    console.error("[/api/food/library/draft] insert failed", error);
    return NextResponse.json({ error: "insert_failed" }, { status: 500 });
  }

  return NextResponse.json({ entry: inserted });
}
