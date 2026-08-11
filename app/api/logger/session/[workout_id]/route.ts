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
// The target-hit stamp is cleared BEFORE the workout delete, not after.
// That ordering — not just "settle target-hit before recomputing the
// week" — is what removes the unrecoverable state: if the clear fails, the
// route aborts with the workout still intact, so a retry is meaningful. If
// the clear succeeds and the delete then fails, the block is left
// momentarily un-consolidated, which is the safe direction and self-heals
// on the next ordinary commit. The re-evaluation after the delete is
// non-fatal for the same reason — failing there just leaves the stamp
// null, and null does not trip evaluateAndStampTargetHit's "already
// stamped" guard, so the next commit repairs it too. Only the clear needs
// to gate the delete; nothing after the delete does.
//
// repatchRemainingWeek still runs after the re-evaluation, so the week
// recomputes against settled target-hit state rather than a momentarily
// cleared one.

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { clearTargetHitStamp, reevaluateTargetHit } from "@/lib/coach/prescription/reevaluate-target-hit";
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

  // 1. Clear any target-hit stamp BEFORE the delete — fatal on failure. The
  //    workout must never be deleted while it might be the reason the block
  //    is stamped; aborting here leaves the workout intact and a retry
  //    meaningful. See the module header for why this is the one step in
  //    this route that has to gate rather than run best-effort.
  let clearResult: { cleared: boolean };
  try {
    clearResult = await clearTargetHitStamp({ supabase, userId: user.id });
  } catch (err) {
    console.error("[logger/session DELETE] clearTargetHitStamp failed:", err);
    return NextResponse.json({ ok: false, reason: "target_hit_clear_failed" }, { status: 500 });
  }
  console.log("[logger/session DELETE] clearTargetHitStamp:", clearResult);

  // 2. The workout itself. exercises + exercise_sets cascade.
  const { error: delErr } = await supabase
    .from("workouts")
    .delete()
    .eq("id", workout_id)
    .eq("user_id", user.id);
  if (delErr) {
    return NextResponse.json({ ok: false, reason: "delete_failed" }, { status: 500 });
  }

  // 3. The debrief card. Best-effort — an orphaned card deep-links to a
  //    session page whose workout is gone, which is cosmetic, not
  //    fatal — but log a failure so a wave of them is diagnosable.
  const { error: debriefErr } = await supabase
    .from("chat_messages")
    .delete()
    .eq("user_id", user.id)
    .eq("kind", "workout_debrief")
    .eq("ui->>workout_id", workout_id);
  if (debriefErr) {
    console.error("[logger/session DELETE] debrief cleanup failed:", debriefErr);
  }

  // 4. Re-derive the target-hit stamp from what's left, then 5. recompute
  //    the rest of the week. Both non-fatal: a failed re-evaluation leaves
  //    the stamp null (self-healing on the next commit, see module header);
  //    a failed repatch leaves the week stale until the next commit or the
  //    Sunday cron, which is its documented backstop.
  try {
    const reevalResult = await reevaluateTargetHit({ supabase, userId: user.id });
    console.log("[logger/session DELETE] reevaluateTargetHit:", reevalResult);
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
