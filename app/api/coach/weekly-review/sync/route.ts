// app/api/coach/weekly-review/sync/route.ts
//
// Vercel cron entrypoint. Sunday 04:00 UTC + Monday 04:00 UTC (catch-up).
// Idempotent on (user_id, week_start) — early-return if a row exists.
// Skips when a plan_week chat session is in flight (last 30 minutes).

import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { generateWeeklyReview } from "@/lib/coach/weekly-review";
import type { WeeklyReviewCardUI } from "@/lib/data/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Grace window: if a plan_week chat session is active within this many ms,
 *  the Sunday cron skips and defers to Monday catch-up. */
const PLAN_WEEK_GRACE_MS = 30 * 60 * 1000;

export async function GET(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || !auth.startsWith("Bearer ") || auth.slice(7) !== cronSecret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sb = createSupabaseServiceRoleClient();

  // Single-user app: pick the first profile. Note: profiles PK is user_id
  // (one row per auth user; see supabase/schema.sql).
  const { data: profile, error: pErr } = await sb
    .from("profiles")
    .select("user_id")
    .order("created_at", { ascending: true })
    .limit(1)
    .single();
  if (pErr || !profile) {
    return NextResponse.json({ error: "no user", detail: pErr?.message }, { status: 404 });
  }
  const userId = profile.user_id as string;

  // Target week_start: Sunday is the LAST day of the week being recapped
  // (the week started 6 days ago on Monday); Monday catch-up reviews the
  // week that ended yesterday (started 7 days ago).
  const today = new Date();
  const dow = today.getUTCDay() || 7; // Mon=1..Sun=7
  const offset = dow === 7 ? 6 : (dow - 1) + 7;
  const lastMonday = new Date(today);
  lastMonday.setUTCDate(today.getUTCDate() - offset);
  const weekStart = lastMonday.toISOString().slice(0, 10);

  // Idempotency: bail if any row exists for this week.
  const { data: existing } = await sb
    .from("weekly_reviews")
    .select("id, status")
    .eq("user_id", userId)
    .eq("week_start", weekStart)
    .limit(1)
    .maybeSingle();
  if (existing) {
    return NextResponse.json({
      ok: true,
      skipped: "exists",
      existing_id: existing.id,
    });
  }

  // Check if an active plan_week chat session is in flight (last 30 min).
  const thirtyMinAgo = new Date(Date.now() - PLAN_WEEK_GRACE_MS).toISOString();
  const { data: activePlanWeek } = await sb
    .from("chat_messages")
    .select("id")
    .eq("user_id", userId)
    .eq("mode", "plan_week")
    .gte("created_at", thirtyMinAgo)
    .limit(1);
  if (activePlanWeek && activePlanWeek.length > 0) {
    return NextResponse.json({ ok: true, skipped: "plan_week_active" });
  }

  const isMondayCatchup = today.getUTCDay() === 1;

  let result;
  try {
    result = await generateWeeklyReview({
      supabase: sb,
      userId,
      weekStart,
      late: isMondayCatchup,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  const nextMonday = shiftDays(weekStart, 7);
  const { data: inserted, error: insErr } = await sb
    .from("weekly_reviews")
    .insert({
      user_id: userId,
      week_start: weekStart,
      next_week_start: nextMonday,
      version: 1,
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

  const cardUi: WeeklyReviewCardUI = {
    schema_version: 1,
    week_start: weekStart,
    next_week_start: nextMonday,
    block_phase_now: result.payload.header.block_phase_now,
    block_phase_next: result.payload.header.block_phase_next,
    one_line_summary: buildOneLine(result.payload),
    per_lift_preview: result.payload.prescription.per_lift.slice(0, 4).map((p) => ({
      lift: shortLift(p.lift),
      from: lookupLastWeekKg(result.payload, p.lift),
      to: `${p.weight_kg}kg`,
    })),
    link_path: `/coach/weeks/${weekStart}`,
    review_id: inserted.id as string,
  };

  const { error: chatErr } = await sb.from("chat_messages").insert({
    user_id: userId,
    kind: "weekly_review",
    role: "assistant",
    content: cardUi.one_line_summary,
    ui: cardUi,
  });
  if (chatErr) {
    // Compensating delete so the next cron run can retry cleanly.
    // Without this, the weekly_reviews row above would trip the idempotency
    // guard while the user has no chat card — silently broken.
    await sb.from("weekly_reviews").delete().eq("id", inserted.id);
    return NextResponse.json({ error: chatErr.message }, { status: 500 });
  }

  revalidatePath("/coach");
  revalidatePath(`/coach/weeks/${weekStart}`);

  return NextResponse.json({ ok: true, review_id: inserted.id });
}

function shiftDays(d: string, days: number): string {
  const dt = new Date(d + "T12:00:00Z");
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
function shortLift(name: string): string {
  return name.replace(/\s*\([^)]+\)/, "");
}
function lookupLastWeekKg(
  payload: import("@/lib/data/types").WeeklyReviewPayload,
  lift: string,
): string {
  const row = payload.recap.per_lift.find((p) => p.lift === lift);
  return row ? `${row.top_set.weight_kg}kg` : "—";
}
function buildOneLine(p: import("@/lib/data/types").WeeklyReviewPayload): string {
  return `Wk ${p.header.week_n} → Wk ${p.header.week_n + 1} · ${p.header.block_phase_next.toUpperCase()} next · ${p.recap.sessions_done}/${p.recap.sessions_planned} sessions`;
}
