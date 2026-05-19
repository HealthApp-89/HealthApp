// app/api/food/parse/route.ts
//
// POST { text, eaten_at? } → draft food_log_entries row + computed totals.
//
// Pipeline: extractItems(text) → resolveItemMacros(item) per item → insert
// draft row → return entry shape to client for preview.

import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { extractItems } from "@/lib/food/parse";
import { resolveItemMacros } from "@/lib/food/lookup";
import { sumMacros, type FoodItem } from "@/lib/food/types";

const BodySchema = z.object({
  text: z.string().min(1).max(2000),
  meal_slot: z.enum(["breakfast", "lunch", "dinner", "snack"]),
  eaten_at: z.string().datetime().optional(),
});

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const json = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

  const { text, eaten_at } = parsed.data;

  // 1. Extract items via Haiku
  let extracted;
  try {
    extracted = await extractItems(text);
  } catch (e) {
    return NextResponse.json(
      { error: "extraction_failed", detail: (e as Error).message },
      { status: 502 },
    );
  }

  // 2. Resolve macros per item (cache → USDA → LLM fallback).
  //    Per-item try/catch: one item exhausting all fallback paths becomes a
  //    zero-macro low-confidence placeholder, not a batch abort. The user
  //    can edit qty or remove the item in preview before committing.
  const items: FoodItem[] = await Promise.all(
    extracted.map(async (it) => {
      try {
        return await resolveItemMacros(it.name, it.qty_g);
      } catch (err) {
        console.warn(`[/api/food/parse] all lookup paths failed for "${it.name}"`, err);
        return {
          name: it.name,
          qty_g: it.qty_g,
          kcal: 0,
          protein_g: 0,
          carbs_g: 0,
          fat_g: 0,
          fiber_g: 0,
          per_100g: { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 },
          source: "llm" as const,
          db_ref: null,
          confidence: "low" as const,
          match_score: null,
        };
      }
    }),
  );

  const totals = sumMacros(items);
  const is_estimated = items.some((it) => it.source === "llm");

  // 3. Insert draft entry
  const { data: inserted, error } = await supabase
    .from("food_log_entries")
    .insert({
      user_id: user.id,
      eaten_at: eaten_at ?? new Date().toISOString(),
      kind: "text",
      meal_slot: parsed.data.meal_slot,
      raw_input: { kind: "text", text },
      items,
      totals,
      is_estimated,
      status: "draft",
    })
    .select("id, eaten_at, meal_slot, kind, items, totals, is_estimated, status")
    .single();
  if (error) {
    console.error("[/api/food/parse] insert failed", error);
    return NextResponse.json({ error: "insert_failed" }, { status: 500 });
  }

  return NextResponse.json({ entry: inserted });
}
