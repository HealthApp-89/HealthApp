// app/api/coach/weekly-review/[id]/regenerate/route.ts
//
// POST: regenerate a weekly review. Re-runs all composers + the narrative,
// inserts a new row with version=N+1, and (if the prior version was a draft)
// flips its status to 'superseded'. Committed versions are immutable — a
// regenerate after commit produces a fresh draft alongside the committed row.
//
// No HMAC: this writes only to weekly_reviews; downstream training_weeks is
// untouched until the user explicitly hits Commit ✓ on the new draft.

import { NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "@/lib/supabase/server";
import { generateWeeklyReview } from "@/lib/coach/weekly-review";
import { revalidatePath } from "next/cache";

export const maxDuration = 60;

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const userSupabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await userSupabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sb = createSupabaseServiceRoleClient();
  const { data: existing, error: rErr } = await sb
    .from("weekly_reviews")
    .select("id, user_id, week_start, version, status")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (rErr || !existing) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Find the highest version row across all statuses for this (user, week)
  // so version=N+1 is always monotonically increasing — even if a later
  // version was already created via a separate path.
  const { data: maxRow } = await sb
    .from("weekly_reviews")
    .select("version")
    .eq("user_id", user.id)
    .eq("week_start", existing.week_start)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  const newVersion = (maxRow?.version ?? existing.version) + 1;

  const today = new Date();
  const isMondayCatchup = today.getUTCDay() === 1;

  let result;
  try {
    result = await generateWeeklyReview({
      supabase: sb,
      userId: user.id,
      weekStart: existing.week_start as string,
      late: isMondayCatchup,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  const nextMonday = shiftDays(existing.week_start as string, 7);
  const { data: inserted, error: insErr } = await sb
    .from("weekly_reviews")
    .insert({
      user_id: user.id,
      week_start: existing.week_start,
      next_week_start: nextMonday,
      version: newVersion,
      status: "draft",
      block_id: result.blockId,
      payload: result.payload,
      narrative_md: result.narrative_md,
      reconfirm_responses: {},
    })
    .select("id")
    .single();
  if (insErr || !inserted) {
    return NextResponse.json(
      { error: insErr?.message ?? "insert failed" },
      { status: 500 },
    );
  }

  // Only supersede the prior row if it was still a draft. Committed and
  // already-superseded rows stay as-is.
  if (existing.status === "draft") {
    await sb
      .from("weekly_reviews")
      .update({ status: "superseded", updated_at: new Date().toISOString() })
      .eq("id", existing.id)
      .eq("user_id", user.id);
  }

  revalidatePath(`/coach/weeks/${existing.week_start}`);

  return NextResponse.json({
    ok: true,
    new_review_id: inserted.id,
    version: newVersion,
  });
}

function shiftDays(d: string, days: number): string {
  const dt = new Date(d + "T12:00:00Z");
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
