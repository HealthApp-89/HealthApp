// app/api/food/user-items/[id]/route.ts
//
// PATCH  → update name / macros / composite / notes.
// DELETE → remove a user_food_items row. Past food_log_entries with this
//          recipe_id have ON DELETE SET NULL so the entry stays, just loses
//          its recipe-collapse affordance.

import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { updateLibraryItem, deleteLibraryItem } from "@/lib/food/library";

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

const PatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  per_100g: Per100gSchema.nullable().optional(),
  composite_of: z.array(CompositeSchema).max(20).nullable().optional(),
  default_serving_g: z.number().positive().finite().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const json = await req.json().catch(() => null);
  const parsed = PatchSchema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

  const result = await updateLibraryItem(supabase, id, parsed.data);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const result = await deleteLibraryItem(supabase, id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 });
  return NextResponse.json({ ok: true });
}
