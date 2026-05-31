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

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Returns the upcoming Monday in YYYY-MM-DD form (UTC). When today is
 *  Sunday returns tomorrow; on Monday returns one week from today; otherwise
 *  returns the Monday after this week. Always strictly greater than today. */
function nextMondayIso(now: Date = new Date()): string {
  const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = t.getUTCDay(); // 0=Sun..6=Sat
  // Days until next Monday: Sun=1, Mon=7, Tue=6, Wed=5, Thu=4, Fri=3, Sat=2
  const daysToAdd = day === 1 ? 7 : (8 - day) % 7;
  t.setUTCDate(t.getUTCDate() + (daysToAdd === 0 ? 7 : daysToAdd));
  return t.toISOString().slice(0, 10);
}

export async function GET(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || !auth.startsWith("Bearer ") || auth.slice(7) !== cronSecret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sb = createSupabaseServiceRoleClient();
  const todayIso = new Date().toISOString().slice(0, 10);
  const weekStart = nextMondayIso();

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

  const results: Array<{ user_id: string; ok: boolean; detail?: string; inserted?: boolean }> = [];
  for (const row of activeBlocks ?? []) {
    const userId = (row as { user_id: string }).user_id;
    try {
      const out = await upsertWeekPrescription({
        supabase: sb,
        userId,
        weekStart,
        todayIso,
      });
      results.push({ user_id: userId, ok: true, inserted: out.inserted });
    } catch (e) {
      console.error("[sunday-prescriptions.sync] user failed", userId, e);
      results.push({ user_id: userId, ok: false, detail: String(e) });
    }
  }

  return NextResponse.json({
    ok: true,
    week_start: weekStart,
    today: todayIso,
    users_processed: results.length,
    results,
  });
}
