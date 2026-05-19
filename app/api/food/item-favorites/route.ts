// app/api/food/item-favorites/route.ts
//
// GET  → list user's favorited food items
// POST → upsert a favorite by (user_id, lower(name))

import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const COLS = "id, user_id, name, qty_g, per_100g, source, db_ref, default_meal_slot, display_order, created_at";

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("food_item_favorites")
    .select(COLS)
    .eq("user_id", user.id)
    .order("display_order", { ascending: true })
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: "query_failed" }, { status: 500 });
  return NextResponse.json({ favorites: data ?? [] });
}

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

const PostSchema = z.object({
  name: z.string().min(1).max(200),
  qty_g: z.number().positive().finite(),
  per_100g: MacrosSchema,
  source: z.enum(["db", "llm"]),
  db_ref: DbRefSchema,
  default_meal_slot: z.enum(["breakfast", "lunch", "dinner", "snack"]).optional(),
});

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const json = await req.json().catch(() => null);
  const parsed = PostSchema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

  // Try insert. On unique-violation (user_id + lower(name) duplicate), return the existing row.
  const { data: inserted, error: insertError } = await supabase
    .from("food_item_favorites")
    .insert({
      user_id: user.id,
      name: parsed.data.name,
      qty_g: parsed.data.qty_g,
      per_100g: parsed.data.per_100g,
      source: parsed.data.source,
      db_ref: parsed.data.db_ref ?? null,
      default_meal_slot: parsed.data.default_meal_slot ?? null,
    })
    .select(COLS)
    .single();

  if (insertError) {
    // 23505 = unique_violation. Fetch and return existing row instead.
    if (insertError.code === "23505") {
      const { data: existing } = await supabase
        .from("food_item_favorites")
        .select(COLS)
        .eq("user_id", user.id)
        .ilike("name", parsed.data.name)
        .maybeSingle();
      if (existing) return NextResponse.json({ favorite: existing });
    }
    console.error("[/api/food/item-favorites POST] insert failed", insertError);
    return NextResponse.json({ error: "insert_failed" }, { status: 500 });
  }

  return NextResponse.json({ favorite: inserted });
}
