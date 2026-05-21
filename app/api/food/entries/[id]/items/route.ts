// app/api/food/entries/[id]/items/route.ts
//
// PATCH the items[] array on a draft food_log_entries row. Refuses if the
// row is committed — items on a committed entry are frozen.
//
// Body shape mirrors the items[] column: an array of FoodItem-like objects.
// Server recomputes totals + is_estimated rather than trusting the client.

import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { sumMacros, type FoodItem } from "@/lib/food/types";

const MacrosSchema = z.object({
  kcal: z.number().finite().nonnegative(),
  protein_g: z.number().finite().nonnegative(),
  carbs_g: z.number().finite().nonnegative(),
  fat_g: z.number().finite().nonnegative(),
  fiber_g: z.number().finite().nonnegative(),
});

const ItemSchema = z.object({
  name: z.string().min(1),
  qty_g: z.number().positive().finite(),
  kcal: z.number().finite().nonnegative(),
  protein_g: z.number().finite().nonnegative(),
  carbs_g: z.number().finite().nonnegative(),
  fat_g: z.number().finite().nonnegative(),
  fiber_g: z.number().finite().nonnegative(),
  per_100g: MacrosSchema,
  source: z.enum(["db", "llm"]),
  db_ref: z.object({
    source: z.enum(["usda", "openfoodfacts", "manual", "user_library"]),
    canonical_id: z.string(),
  }).nullable(),
  confidence: z.enum(["high", "medium", "low"]).nullable(),
  match_score: z.number().min(0).max(1).nullable(),
});

const BodySchema = z.object({
  items: z.array(ItemSchema).min(1).max(30),
});

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const json = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

  // Refuse on committed; RLS scopes to the user.
  const { data: existing, error: readErr } = await supabase
    .from("food_log_entries")
    .select("id, status")
    .eq("id", id)
    .single();
  if (readErr || !existing) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if ((existing as { status: string }).status === "committed") {
    return NextResponse.json({ error: "committed_entries_are_frozen" }, { status: 409 });
  }

  const items = parsed.data.items as FoodItem[];
  const totals = sumMacros(items);
  const is_estimated = items.some((it) => it.source === "llm");

  const { data: updated, error: updErr } = await supabase
    .from("food_log_entries")
    .update({ items, totals, is_estimated })
    .eq("id", id)
    .select("id, eaten_at, meal_slot, kind, items, totals, is_estimated, is_favorite, status")
    .single();
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
  return NextResponse.json({ entry: updated });
}
