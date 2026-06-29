// app/api/training-weeks/[week_start]/apply-activity-layout/route.ts
//
// Propose-then-confirm surface for the activity-aware layout planner.
//
// The Sunday cron (sunday-prescriptions/sync) and weekly review flow call
// computeActivityLayoutProposal which returns a proposedPlan (day moves) and
// flags (unresolvable conflicts). When the athlete approves, the client POSTs
// the proposedPlan here and this endpoint applies it by:
//
//   1. Diffing proposedPlan vs current session_plan to find changed days.
//   2. Writing the new plan + recomputing session_prescriptions via the same
//      path as the swap endpoint (prescribeWeek → DB update).
//
// This is NOT a parallel apply path — it reuses the same prescribeWeek
// engine and DB update logic as /swap, just applying a full-plan diff
// rather than a single swap operation.
//
// Body: { proposed_plan: SessionPlan }
// Returns: SwapResult shape with before/after per changed day + new week row.

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { computeActivityLayoutProposal } from "@/lib/coach/prescription/prescribe-week";
import { getUserTimezone } from "@/lib/time/get-user-tz";
import { todayInUserTz } from "@/lib/time";
import { plansEqual } from "@/lib/training-weeks/apply-swap";
import { applyActivityLayout } from "@/lib/training-weeks/apply-activity-layout";
import type {
  SessionPlan,
  TrainingBlock,
  TrainingWeek,
} from "@/lib/data/types";

function isYmd(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

const TRAINING_WEEK_SELECT_LIGHT =
  "id, user_id, week_start, session_plan, planned_activities";

const TRAINING_WEEK_SELECT =
  "id, user_id, block_id, week_start, session_plan, original_session_plan, exercise_overrides, session_prescriptions, endurance_session_plan, weekly_focus, intensity_modifier, rir_target, research_phase, proposed_by, chat_message_id, committed_at, created_at, updated_at";

// GET — compute and return the current activity layout proposal for a week.
// Read-only; does not modify any data.
// Response: { ok: true, proposal: ActivityLayoutProposal }
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ week_start: string }> },
) {
  const { week_start } = await ctx.params;
  if (!isYmd(week_start)) {
    return NextResponse.json({ ok: false, error: "week_start must be YYYY-MM-DD" }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const { data: row, error: loadErr } = await supabase
    .from("training_weeks")
    .select(TRAINING_WEEK_SELECT_LIGHT)
    .eq("user_id", user.id)
    .eq("week_start", week_start)
    .maybeSingle();
  if (loadErr) {
    return NextResponse.json({ ok: false, error: `load failed: ${loadErr.message}` }, { status: 500 });
  }
  if (!row) {
    return NextResponse.json(
      { ok: false, error: `no training_weeks row for week_start=${week_start}` },
      { status: 404 },
    );
  }

  const { data: blockRow } = await supabase
    .from("training_blocks")
    .select("*")
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  const block = (blockRow as TrainingBlock | null) ?? null;

  const tz = await getUserTimezone(user.id);
  const todayIso = todayInUserTz(new Date(), tz);

  const proposal = await computeActivityLayoutProposal({
    supabase,
    userId: user.id,
    block,
    week: row as unknown as TrainingWeek,
    todayIso,
  });

  return NextResponse.json({ ok: true, proposal }, { status: 200 });
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ week_start: string }> },
) {
  const { week_start } = await ctx.params;
  if (!isYmd(week_start)) {
    return NextResponse.json({ ok: false, error: "week_start must be YYYY-MM-DD" }, { status: 400 });
  }

  // Auth
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  // Parse body
  let bodyRaw: unknown;
  try {
    bodyRaw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "body must be valid JSON" }, { status: 400 });
  }

  if (
    !bodyRaw ||
    typeof bodyRaw !== "object" ||
    typeof (bodyRaw as Record<string, unknown>).proposed_plan !== "object" ||
    (bodyRaw as Record<string, unknown>).proposed_plan === null
  ) {
    return NextResponse.json({ ok: false, error: "proposed_plan must be an object" }, { status: 400 });
  }

  const proposedPlan = (bodyRaw as Record<string, unknown>).proposed_plan as SessionPlan;

  // Load current week row
  const { data: row, error: loadErr } = await supabase
    .from("training_weeks")
    .select(TRAINING_WEEK_SELECT)
    .eq("user_id", user.id)
    .eq("week_start", week_start)
    .maybeSingle();
  if (loadErr) {
    return NextResponse.json({ ok: false, error: `load failed: ${loadErr.message}` }, { status: 500 });
  }
  if (!row) {
    return NextResponse.json(
      { ok: false, error: `no training_weeks row for week_start=${week_start}` },
      { status: 404 },
    );
  }

  const current = row.session_plan as SessionPlan;

  // Identity check — no-op if proposed === current
  if (plansEqual(proposedPlan, current)) {
    return NextResponse.json({ ok: true, week: row, changed_days: [] }, { status: 200 });
  }

  const result = await applyActivityLayout({
    supabase,
    userId: user.id,
    weekStart: week_start,
    proposedPlan,
  });
  if (!result.ok) {
    const status = result.code === "no_week" ? 404 : 500;
    return NextResponse.json({ ok: false, error: result.error }, { status });
  }
  return NextResponse.json(
    { ok: true, week: result.week, changed_days: result.changedDays },
    { status: 200 },
  );
}
