import { NextResponse } from "next/server";
import { commitSession } from "@/lib/logger/commit-session";
import type { CommitSessionPayload } from "@/lib/logger/types";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { evaluateAndStampTargetHit } from "@/lib/coach/prescription/target-hit-evaluator";
import { repatchRemainingWeek } from "@/lib/coach/prescription/repatch-week";
import { getUserTimezone } from "@/lib/time/get-user-tz";
import { todayInUserTz } from "@/lib/time";

export async function POST(req: Request) {
  let payload: CommitSessionPayload;
  try {
    payload = (await req.json()) as CommitSessionPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (
    !payload.user_id ||
    !payload.external_id ||
    !payload.date ||
    !payload.type ||
    !Array.isArray(payload.exercises)
  ) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  try {
    const result = await commitSession(payload);

    const supabase = await createSupabaseServerClient();

    // Target-hit evaluator: scan active block for primary-lift PR ≥ target_value
    // and stamp training_blocks.target_hit_at_week. Non-fatal — retries next commit.
    // MUST run before the repatch so a freshly-crossed target flips the engine
    // into consolidation before the remaining days are recomputed.
    try {
      await evaluateAndStampTargetHit({ supabase, userId: payload.user_id });
    } catch (err) {
      console.error("[logger/session] evaluateAndStampTargetHit failed:", err);
    }

    // Mid-week feed-forward: re-run the engine for the remaining days of the
    // current week now that today's sets (and their RIR) exist. Non-fatal —
    // the Sunday cron is the backstop and next week is always freshly computed.
    try {
      const tz = await getUserTimezone(payload.user_id);
      const todayIso = todayInUserTz(new Date(), tz);
      await repatchRemainingWeek({
        supabase,
        userId: payload.user_id,
        todayIso,
        reason: "workout_commit",
        workoutDate: payload.date,
      });
    } catch (err) {
      console.error("[logger/session] repatchRemainingWeek failed:", err);
    }

    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    const status = msg.includes("authenticated") || msg.includes("mismatch") ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
