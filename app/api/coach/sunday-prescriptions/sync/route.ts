// app/api/coach/sunday-prescriptions/sync/route.ts
//
// Cron entrypoint. Sunday 03:30 UTC (after the weekly-review cron at 04:00 UTC
// has had its previous-day pass, but before Carter chats on Sunday morning).
//
// Iterates every user with an active block, computes prescribeWeek for next
// Monday's session_prescriptions, and upserts into training_weeks. Carter's
// snapshot prefix then reads this row as the canonical answer; no more
// prose-derived loads.
//
// Idempotent: re-running the cron simply re-runs prescribeWeek (the engine
// is deterministic given the same inputs) and overwrites the column. Existing
// training_weeks columns (session_plan, rir_target, etc.) are preserved.

import { NextResponse } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { upsertWeekPrescription } from "@/lib/coach/prescription/upsert-week-prescription";
import { getUserTimezone } from "@/lib/time/get-user-tz";
import { todayInUserTz } from "@/lib/time";
import { currentWeekMonday } from "@/lib/coach/week";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || !auth.startsWith("Bearer ") || auth.slice(7) !== cronSecret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sb = createSupabaseServiceRoleClient();

  // Every user with an ACTIVE block gets a prescription written. Users
  // between blocks skip — there's no phase context to drive prescribeWeek
  // and Carter's between-blocks framework-state block handles the gap.
  const { data: activeBlocks, error: blocksErr } = await sb
    .from("training_blocks")
    .select("user_id")
    .eq("status", "active");
  if (blocksErr) {
    return NextResponse.json({ error: "block_fetch_failed", detail: blocksErr.message }, { status: 500 });
  }

  const results: Array<{ user_id: string; ok: boolean; detail?: string; inserted?: boolean; week_start?: string }> = [];
  for (const row of activeBlocks ?? []) {
    const userId = (row as { user_id: string }).user_id;
    try {
      const tz = await getUserTimezone(userId);
      const todayIso = todayInUserTz(new Date(), tz);
      const thisMonday = currentWeekMonday(new Date(), tz);
      const nextMonday = (() => {
        // Add 7 days to the YYYY-MM-DD via UTC-noon parsing (DST-safe).
        const dt = new Date(`${thisMonday}T12:00:00Z`);
        dt.setUTCDate(dt.getUTCDate() + 7);
        return dt.toISOString().slice(0, 10);
      })();
      const out = await upsertWeekPrescription({
        supabase: sb,
        userId,
        weekStart: nextMonday,
        todayIso,
      });
      results.push({ user_id: userId, ok: true, inserted: out.inserted, week_start: nextMonday });
    } catch (e) {
      console.error("[sunday-prescriptions.sync] user failed", userId, e);
      results.push({ user_id: userId, ok: false, detail: String(e) });
    }
  }

  return NextResponse.json({
    ok: true,
    users_processed: results.length,
    results,
  });
}
