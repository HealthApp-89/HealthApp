// app/api/food/entries/[id]/copy/route.ts
//
// POST { eaten_at?, meal_slot? } → clone an existing committed entry as a
// new draft. Defaults: eaten_at = now(), meal_slot = source's slot.

import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const BodySchema = z.object({
  eaten_at: z.string().datetime().optional(),
  meal_slot: z.enum(["breakfast", "lunch", "dinner", "snack"]).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const json = await req.json().catch(() => ({}));
  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

  const { data: source, error: fetchError } = await supabase
    .from("food_log_entries")
    .select("items, totals, is_estimated, meal_slot")
    .eq("id", id)
    .eq("user_id", user.id)
    .eq("status", "committed")
    .maybeSingle();
  if (fetchError) {
    console.error("[/api/food/entries/[id]/copy] fetch failed", fetchError);
    return NextResponse.json({ error: "fetch_failed" }, { status: 500 });
  }
  if (!source) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const meal_slot = parsed.data.meal_slot ?? source.meal_slot;
  const eaten_at = parsed.data.eaten_at ?? new Date().toISOString();

  const { data: inserted, error: insertError } = await supabase
    .from("food_log_entries")
    .insert({
      user_id: user.id,
      eaten_at,
      meal_slot,
      kind: "copy",
      raw_input: { kind: "copy", source_id: id },
      items: source.items,
      totals: source.totals,
      is_estimated: source.is_estimated,
      is_favorite: false,
      status: "draft",
    })
    .select("id, eaten_at, meal_slot, kind, items, totals, is_estimated, is_favorite, status")
    .single();
  if (insertError) {
    console.error("[/api/food/entries/[id]/copy] insert failed", insertError);
    return NextResponse.json({ error: "insert_failed" }, { status: 500 });
  }

  return NextResponse.json({ entry: inserted });
}
