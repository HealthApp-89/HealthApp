// app/api/logger/session/[workout_id]/route.ts
//
// Full unwind of a mistakenly-saved session. Deleting the workout row is the
// easy part (exercises and exercise_sets cascade, schema.sql:60,67). The
// engine effects the commit fed forward do not reverse on their own:
//
//   - evaluateAndStampTargetHit stamped training_blocks.target_hit_at_week
//     and only ever stamps. A phantom stamp locks the block into
//     consolidation for the rest of its run.
//   - repatchRemainingWeek rewrote the remaining days' prescribed loads.
//
// Order matters and mirrors the commit path: the target-hit state settles
// before the week is recomputed against it.

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { reevaluateTargetHit } from "@/lib/coach/prescription/reevaluate-target-hit";
import { repatchRemainingWeek } from "@/lib/coach/prescription/repatch-week";
import { getUserTimezone } from "@/lib/time/get-user-tz";
import { todayInUserTz } from "@/lib/time";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ workout_id: string }> },
) {
  const { workout_id } = await ctx.params;
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }

  const { data: workout, error: fetchErr } = await supabase
    .from("workouts")
    .select("id, date, source")
    .eq("id", workout_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (fetchErr) {
    return NextResponse.json({ ok: false, reason: "fetch_failed" }, { status: 500 });
  }
  if (!workout) {
    return NextResponse.json({ ok: false, reason: "not_found" }, { status: 404 });
  }
  if (workout.source !== "logger") {
    // Strong CSV imports are re-importable from their source file; deleting
    // them here would be a one-way loss with no undo.
    return NextResponse.json({ ok: false, reason: "not_logger_sourced" }, { status: 400 });
  }

  // 1. The workout itself. exercises + exercise_sets cascade.
  const { error: delErr } = await supabase
    .from("workouts")
    .delete()
    .eq("id", workout_id)
    .eq("user_id", user.id);
  if (delErr) {
    return NextResponse.json({ ok: false, reason: "delete_failed" }, { status: 500 });
  }

  // 2. The debrief card. Best-effort — an orphaned card is cosmetic, and
  //    the workout is already gone.
  try {
    await supabase
      .from("chat_messages")
      .delete()
      .eq("user_id", user.id)
      .eq("kind", "workout_debrief")
      .eq("ui->>workout_id", workout_id);
  } catch (err) {
    console.error("[logger/session DELETE] debrief cleanup failed:", err);
  }

  // 3. Re-derive the target-hit stamp, then 4. recompute the rest of the
  //    week. Both non-fatal: the Sunday cron is the backstop for the week,
  //    and the next commit re-runs the evaluator.
  try {
    await reevaluateTargetHit({ supabase, userId: user.id });
  } catch (err) {
    console.error("[logger/session DELETE] reevaluateTargetHit failed:", err);
  }

  try {
    const tz = await getUserTimezone(user.id);
    await repatchRemainingWeek({
      supabase,
      userId: user.id,
      todayIso: todayInUserTz(new Date(), tz),
      reason: "workout_unwound",
      workoutDate: workout.date as string,
    });
  } catch (err) {
    console.error("[logger/session DELETE] repatchRemainingWeek failed:", err);
  }

  return NextResponse.json({ ok: true });
}
