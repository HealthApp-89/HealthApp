// app/api/food/entries/[id]/favorite/route.ts
//
// PATCH { value: boolean } → toggle is_favorite on an entry. Reaggregation
// is NOT called — favoriting doesn't change macros.

import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const BodySchema = z.object({ value: z.boolean() });

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const json = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

  const { data: updated, error } = await supabase
    .from("food_log_entries")
    .update({ is_favorite: parsed.data.value, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", user.id)
    .select("id, is_favorite")
    .single();
  if (error) {
    console.error("[/api/food/entries/[id]/favorite] update failed", error);
    return NextResponse.json({ error: "update_failed" }, { status: 500 });
  }
  if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });

  return NextResponse.json({ ok: true, is_favorite: updated.is_favorite });
}
