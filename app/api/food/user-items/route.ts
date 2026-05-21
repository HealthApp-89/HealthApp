// app/api/food/user-items/route.ts
//
// POST → create a user_food_items row (single item or recipe).
// GET  → list/search user_food_items (used by Manage Library page + Nora's
//        search_library tool when called from the chat surface).
//
// NB: the sibling /api/food/library route (v1.1) is a sections endpoint
// returning favorite_meals/recent/frequent/catalog for the MealLoggerSheet
// Library tab. The "user-items" path here owns CRUD on the user_food_items
// table that backs Nora's meal-log mode and the Manage Library page.

import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  createLibraryItem,
  listLibraryItems,
  type CreateLibraryItemInput,
} from "@/lib/food/library";

const Per100gSchema = z.object({
  kcal: z.number().finite().nonnegative(),
  protein_g: z.number().finite().nonnegative(),
  carbs_g: z.number().finite().nonnegative(),
  fat_g: z.number().finite().nonnegative(),
  fiber_g: z.number().finite().nonnegative(),
});

const CompositeSchema = z.object({
  name: z.string().min(1),
  qty_g: z.number().positive().finite(),
});

const CreateBodySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("item"),
    name: z.string().min(1).max(120),
    per_100g: Per100gSchema,
    source: z.enum(["user_manual", "user_label"]),
    notes: z.string().max(2000).nullish(),
  }),
  z.object({
    kind: z.literal("recipe"),
    name: z.string().min(1).max(120),
    composite_of: z.array(CompositeSchema).min(1).max(20),
    default_serving_g: z.number().positive().finite(),
    source: z.literal("user_recipe"),
    notes: z.string().max(2000).nullish(),
  }),
]);

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const json = await req.json().catch(() => null);
  const parsed = CreateBodySchema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

  const result = await createLibraryItem(supabase, parsed.data as CreateLibraryItemInput);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 });
  return NextResponse.json({ id: result.id });
}

const QuerySchema = z.object({
  q: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({
    q: url.searchParams.get("q") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

  const items = await listLibraryItems(supabase, parsed.data.q, parsed.data.limit);
  return NextResponse.json({ items });
}
