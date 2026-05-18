// app/api/food/commit/route.ts
//
// POST { entry_id } → flip status to 'committed', reaggregate daily_logs
// for the entry's date, invalidate /log via revalidatePath.

import { NextResponse } from "next/server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { reaggregateDay } from "@/lib/food/aggregate";

const BodySchema = z.object({
  entry_id: z.string().uuid(),
});

function utcDate(iso: string): string {
  return iso.slice(0, 10);
}

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const json = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

  const { entry_id } = parsed.data;

  // Update status. RLS scopes to the user.
  const { data: updated, error } = await supabase
    .from("food_log_entries")
    .update({ status: "committed", updated_at: new Date().toISOString() })
    .eq("id", entry_id)
    .eq("user_id", user.id)
    .select("id, eaten_at, totals")
    .single();
  if (error || !updated) {
    console.error("[/api/food/commit] update failed", error);
    return NextResponse.json({ error: "commit_failed" }, { status: 500 });
  }

  const date = utcDate(updated.eaten_at);
  const macros = await reaggregateDay(supabase, user.id, date);

  revalidatePath("/log");
  revalidatePath("/");

  return NextResponse.json({ ok: true, date, totals: macros });
}
