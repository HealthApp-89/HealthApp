// app/api/profile/nutrition-overrides/route.ts
//
// POST → partial-update profiles.nutrition_overrides. Per-field semantics:
//   - undefined / key absent → leave existing value as-is
//   - null                   → clear that field
//   - value                  → set
// Empty resulting object collapses to a NULL column write so getTodayTargets
// can fast-path "no overrides" without a key-count check.
//
// Validation:
//   - kcal: integer in [800, 6000]
//   - macro_ratios: {protein_pct, carbs_pct, fat_pct} each in [0,1], sum ≈ 1.0
//   - meal_ratios:  {breakfast, lunch, dinner, snacks} each in [0,1], sum ≈ 1.0
//   - Unknown top-level keys rejected (.strict).

import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const RatiosSchema = (keys: readonly string[]) =>
  z
    .object(
      Object.fromEntries(keys.map((k) => [k, z.number().min(0).max(1)])),
    )
    .refine(
      (o) =>
        Math.abs(
          Object.values(o as Record<string, number>).reduce(
            (a, b) => a + b,
            0,
          ) - 1,
        ) < 0.01,
      "ratios must sum to 1.0 (±0.01)",
    );

const Body = z
  .object({
    kcal: z.number().int().min(800).max(6000).nullable().optional(),
    macro_ratios: RatiosSchema(["protein_pct", "carbs_pct", "fat_pct"])
      .nullable()
      .optional(),
    meal_ratios: RatiosSchema(["breakfast", "lunch", "dinner", "snacks"])
      .nullable()
      .optional(),
  })
  .strict();

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Build the override object by merging the patch into existing.
  // Send `null` to clear a field; omit to keep existing.
  const { data: existing } = await supabase
    .from("profiles")
    .select("nutrition_overrides")
    .eq("user_id", user.id)
    .maybeSingle();
  const current = (existing?.nutrition_overrides ?? {}) as Record<
    string,
    unknown
  >;
  const next: Record<string, unknown> = { ...current };

  for (const key of ["kcal", "macro_ratios", "meal_ratios"] as const) {
    if (key in parsed.data) {
      const v = parsed.data[key];
      if (v === null) delete next[key];
      else next[key] = v;
    }
  }

  // Empty object → store NULL to mean "no overrides".
  const finalValue = Object.keys(next).length === 0 ? null : next;

  const { error } = await supabase
    .from("profiles")
    .update({ nutrition_overrides: finalValue })
    .eq("user_id", user.id);
  if (error) {
    console.error(
      "[/api/profile/nutrition-overrides] update failed",
      error,
    );
    return NextResponse.json({ error: "update_failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, nutrition_overrides: finalValue });
}
