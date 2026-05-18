// app/api/food/entries/[id]/route.ts
//
// PATCH { items } → replace items, recompute totals + is_estimated, reaggregate.
//   (Today-only constraint: rejects edits to entries with eaten_at not today.)
// DELETE → set status='rejected', reaggregate (drops the entry from totals).

import { NextResponse } from "next/server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { reaggregateDay } from "@/lib/food/aggregate";
import { sumMacros, type FoodItem } from "@/lib/food/types";
import { utcDate, isToday } from "@/lib/food/date";

const ItemSchema = z.object({
  name: z.string(),
  qty_g: z.number().positive().finite(),
  kcal: z.number().nonnegative(),
  protein_g: z.number().nonnegative(),
  carbs_g: z.number().nonnegative(),
  fat_g: z.number().nonnegative(),
  fiber_g: z.number().nonnegative(),
  per_100g: z.object({
    kcal: z.number().nonnegative(),
    protein_g: z.number().nonnegative(),
    carbs_g: z.number().nonnegative(),
    fat_g: z.number().nonnegative(),
    fiber_g: z.number().nonnegative(),
  }),
  source: z.enum(["db", "llm"]),
  db_ref: z
    .object({
      source: z.enum(["usda", "openfoodfacts", "manual"]),
      canonical_id: z.string().uuid(),
    })
    .nullable(),
  confidence: z.enum(["high", "medium", "low"]).nullable(),
});

const PatchSchema = z.object({
  items: z.array(ItemSchema).min(1),
});

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const json = await req.json().catch(() => null);
  const parsed = PatchSchema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

  // Fetch the entry first (today-only check).
  const { data: existing } = await supabase
    .from("food_log_entries")
    .select("eaten_at")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();
  if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });
  // Note: UTC date bucketing — entries logged 23:00-00:00 local in CET may
  // not be editable as "today" once the UTC midnight tick has passed. Known
  // limitation; see spec §"Open items" for the per-user-TZ fix path.
  if (!isToday(existing.eaten_at)) {
    return NextResponse.json({ error: "edit_past_day_disallowed" }, { status: 403 });
  }

  const items = parsed.data.items as FoodItem[];
  const totals = sumMacros(items);
  const is_estimated = items.some((it) => it.source === "llm");

  const { error } = await supabase
    .from("food_log_entries")
    .update({ items, totals, is_estimated, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", user.id);
  if (error) return NextResponse.json({ error: "update_failed" }, { status: 500 });

  const date = utcDate(existing.eaten_at);
  await reaggregateDay(supabase, user.id, date);
  revalidatePath("/log");
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data: existing } = await supabase
    .from("food_log_entries")
    .select("eaten_at")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();
  if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const { error } = await supabase
    .from("food_log_entries")
    .update({ status: "rejected", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", user.id);
  if (error) return NextResponse.json({ error: "delete_failed" }, { status: 500 });

  const date = utcDate(existing.eaten_at);
  await reaggregateDay(supabase, user.id, date);
  revalidatePath("/log");
  return NextResponse.json({ ok: true });
}
