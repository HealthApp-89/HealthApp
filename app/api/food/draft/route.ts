// app/api/food/draft/route.ts
//
// POST { items: Array<{ candidate: SearchCandidate, qty_g: number }>,
//        meal_slot, eaten_at? } → draft food_log_entries row.
//
// For each picked candidate:
//   - If canonical_id is null (fresh OFF/USDA hit), insert into food_db_cache
//     to obtain a canonical_id (cache write at pick-time, not search-time).
//   - Compute macros via macrosForQty and build a FoodItem.

import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { macrosForQty, sumMacros, type FoodItem, type FoodDbCacheRow } from "@/lib/food/types";

const CandidateSchema = z.object({
  name: z.string().min(1),
  per_100g: z.object({
    kcal: z.number().nonnegative(),
    protein_g: z.number().nonnegative(),
    carbs_g: z.number().nonnegative(),
    fat_g: z.number().nonnegative(),
    fiber_g: z.number().nonnegative(),
  }),
  source: z.enum(["db", "off", "usda"]),
  canonical_id: z.string().uuid().nullable(),
  image_url: z.string().url().nullable(),
});

const BodySchema = z.object({
  items: z.array(z.object({
    candidate: CandidateSchema,
    qty_g: z.number().positive().finite(),
  })).min(1).max(15),
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

  const serviceClient = createSupabaseServiceRoleClient();

  // Resolve each candidate → ensure canonical_id, build FoodItem.
  const items: FoodItem[] = [];
  for (const { candidate, qty_g } of parsed.data.items) {
    let canonical_id = candidate.canonical_id;
    let db_source: "usda" | "openfoodfacts" | "manual";

    if (candidate.source === "db") {
      if (!canonical_id) {
        return NextResponse.json({ error: "db_candidate_missing_canonical_id" }, { status: 400 });
      }
      // Fetch source from cache so we set db_ref.source correctly.
      const { data: cached } = await serviceClient
        .from("food_db_cache")
        .select("source")
        .eq("canonical_id", canonical_id)
        .single();
      const src = (cached as { source?: string } | null)?.source;
      if (src === "usda" || src === "openfoodfacts" || src === "manual") {
        db_source = src;
      } else {
        return NextResponse.json({ error: "db_candidate_source_unknown" }, { status: 400 });
      }
    } else {
      // Fresh OFF or USDA hit — write to cache to materialise canonical_id.
      db_source = candidate.source === "off" ? "openfoodfacts" : "usda";
      const { data: inserted, error } = await serviceClient
        .from("food_db_cache")
        .insert({
          source: db_source,
          upc: null,
          name: candidate.name,
          per_100g: candidate.per_100g,
          serving_size_g: null,
          raw_payload: { picked_via: "search", at: new Date().toISOString() },
        })
        .select("*")
        .single();
      if (error || !inserted) {
        console.error("[/api/food/draft] cache insert failed", error);
        return NextResponse.json({ error: "cache_insert_failed" }, { status: 500 });
      }
      canonical_id = (inserted as FoodDbCacheRow).canonical_id;
    }

    const macros = macrosForQty(candidate.per_100g, qty_g);
    items.push({
      name: candidate.name,
      qty_g,
      ...macros,
      per_100g: candidate.per_100g,
      source: "db",
      db_ref: { source: db_source, canonical_id },
      confidence: "high",
      match_score: 1.0,  // User-picked — treated as ground truth
    });
  }

  const totals = sumMacros(items);

  const candidatesSnapshot = parsed.data.items.map((it) => it.candidate);
  const qtySnapshot = parsed.data.items.map((it) => it.qty_g);

  const { data: inserted, error } = await supabase
    .from("food_log_entries")
    .insert({
      user_id: user.id,
      eaten_at: parsed.data.eaten_at ?? new Date().toISOString(),
      kind: "text",
      meal_slot: parsed.data.meal_slot,
      raw_input: { kind: "text", source: "search", items: candidatesSnapshot, qty_g: qtySnapshot },
      items,
      totals,
      is_estimated: false,
      status: "draft",
    })
    .select("id, eaten_at, meal_slot, kind, items, totals, is_estimated, status")
    .single();
  if (error || !inserted) {
    console.error("[/api/food/draft] entry insert failed", error);
    return NextResponse.json({ error: "insert_failed" }, { status: 500 });
  }

  return NextResponse.json({ entry: inserted });
}
