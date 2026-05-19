// app/api/food/barcode/route.ts
//
// POST { upc, qty_g?, eaten_at? } → draft entry, or 404 if OFF has no match.

import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { lookupBarcode } from "@/lib/food/barcode";
import { macrosForQty, type FoodItem } from "@/lib/food/types";

const BodySchema = z.object({
  upc: z.string().regex(/^\d{8,14}$/),
  qty_g: z.number().positive().finite().optional(),
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

  const { upc, eaten_at } = parsed.data;

  const product = await lookupBarcode(upc);
  if (!product) {
    return NextResponse.json({ error: "product_not_found", upc }, { status: 404 });
  }

  const qty_g = parsed.data.qty_g ?? product.serving_size_g ?? 100;
  const macros = macrosForQty(product.per_100g, qty_g);

  const item: FoodItem = {
    name: product.name,
    qty_g,
    ...macros,
    per_100g: product.per_100g,
    source: "db",
    db_ref: { source: "openfoodfacts", canonical_id: product.canonical_id },
    confidence: "high",
  };

  const { data: inserted, error } = await supabase
    .from("food_log_entries")
    .insert({
      user_id: user.id,
      eaten_at: eaten_at ?? new Date().toISOString(),
      kind: "barcode",
      meal_slot: parsed.data.meal_slot,
      raw_input: { kind: "barcode", upc, qty_g },
      items: [item],
      totals: macros,
      is_estimated: false,
      is_favorite: false,
      status: "draft",
    })
    .select("id, eaten_at, meal_slot, kind, items, totals, is_estimated, is_favorite, status")
    .single();
  if (error) {
    console.error("[/api/food/barcode] insert failed", error);
    return NextResponse.json({ error: "insert_failed" }, { status: 500 });
  }

  return NextResponse.json({
    entry: inserted,
    product_image: (product.raw_payload as { image_front_url?: string }).image_front_url ?? null,
  });
}
