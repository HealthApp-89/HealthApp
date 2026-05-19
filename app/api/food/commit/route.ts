// app/api/food/commit/route.ts
//
// POST { entry_id } → flip status to 'committed', reaggregate daily_logs
// for the entry's date, invalidate /meal via revalidatePath.

import { NextResponse } from "next/server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { reaggregateDay, sumFoodEntriesForDate } from "@/lib/food/aggregate";
import { utcDate } from "@/lib/food/date";
import { foodLogOwnsDailyLogs } from "@/lib/food/ownership";

const BodySchema = z.object({
  entry_id: z.string().uuid(),
});

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
  if (error) {
    console.error("[/api/food/commit] update failed", error);
    return NextResponse.json({ error: "commit_failed" }, { status: 500 });
  }
  if (!updated) {
    // Entry doesn't exist, isn't owned by this user, or has already been
    // committed/rejected (status update matched 0 rows).
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const date = utcDate(updated.eaten_at);
  // When the kill switch is off, Yazio remains the source of truth for the
  // daily_logs nutrition columns — sum the committed entries for the response
  // (so the UI can render today's running totals) but skip the upsert.
  const macros = foodLogOwnsDailyLogs()
    ? await reaggregateDay(supabase, user.id, date)
    : await sumFoodEntriesForDate(supabase, user.id, date);

  revalidatePath("/meal");
  revalidatePath("/");

  return NextResponse.json({ ok: true, date, totals: macros });
}
