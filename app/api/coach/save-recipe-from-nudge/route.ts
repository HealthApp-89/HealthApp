// app/api/coach/save-recipe-from-nudge/route.ts
//
// One-shot: insert user_food_items row from a save-recipe nudge tap. Tracks
// metadata.source='recipe_discovery' for the spec §9.6 tight-loop boost
// (suggest-meal scores newly-saved discovery recipes higher for 7 days).
//
// 23505 unique violation (against user_food_items_user_name_unique from
// migration 0030) is treated as a successful no-op so the user sees
// "already in library" rather than thinking the save failed.

import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const Per100g = z.object({
  kcal: z.number(),
  protein_g: z.number(),
  carbs_g: z.number(),
  fat_g: z.number(),
  fiber_g: z.number(),
});

const Body = z.object({
  name: z.string().min(1).max(80),
  composite_of: z
    .array(
      z.object({
        name: z.string(),
        qty_g: z.number().nonnegative(),
        per_100g: Per100g,
      }),
    )
    .min(2),
  per_100g: Per100g,
  combo_signature: z.string(),
});

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { error, data } = await supabase
    .from("user_food_items")
    .insert({
      user_id: user.id,
      name: parsed.data.name,
      composite_of: parsed.data.composite_of,
      per_100g: parsed.data.per_100g,
      metadata: {
        source: "recipe_discovery",
        combo_signature: parsed.data.combo_signature,
      },
    })
    .select("id")
    .single();

  // 23505 = unique_violation on user_food_items_user_name_unique. Look up the
  // existing row's id and return was_duplicate so the UI can confirm save
  // without surfacing a failure.
  if (error?.code === "23505") {
    const { data: existing } = await supabase
      .from("user_food_items")
      .select("id")
      .eq("user_id", user.id)
      .ilike("name", parsed.data.name)
      .maybeSingle();
    return NextResponse.json({ id: existing?.id, was_duplicate: true });
  }
  if (error) {
    return NextResponse.json(
      { error: "write_failed", detail: error.message },
      { status: 500 },
    );
  }

  return NextResponse.json({ id: data?.id, was_duplicate: false });
}
