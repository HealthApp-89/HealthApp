// app/api/training-weeks/[week_start]/manual-edits/route.ts
//
// PATCH — write or clear the manual_session_edits entry for a single weekday
// of the current week's training_weeks row.
//
// Body: { weekday: WeekdayLong, edits: { order?, exercises? } | null }
//
//  - null edits   → delete this weekday's key (auto-set column to NULL when
//                   the resulting object is empty).
//  - non-null     → validate then merge-write the weekday key.
//
// Guards:
//  1. week_start must be a valid YYYY-MM-DD AND the current week's Monday in
//     the user's timezone (prevents stale edits to past/future weeks).
//  2. weekday must be one of the 7 WeekdayLong values.
//  3. A training_weeks row must exist for (user_id, week_start) → 404.
//  4. Edits validated by validateDayEdits against the server-resolved exercise
//     list (resolveSessionPlan without the manual layer) — the helper reduces
//     it to the deduplicated NON-WARMUP name universe internally.
//
// Returns the updated day's resolved exercise list (with edits applied) so the
// client can update its UI without a separate refetch.

import { NextResponse } from "next/server";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { getUserTimezone } from "@/lib/time/get-user-tz";
import { todayInUserTz } from "@/lib/time";
import { currentWeekMonday } from "@/lib/coach/week";
import { readSessionForDay } from "@/lib/coach/session-plan-reader";
import { resolveSessionPlan } from "@/lib/logger/resolve-plan";
import { validateDayEdits } from "@/lib/coach/manual-edits";
import { applyManualSessionEdits } from "@/lib/coach/manual-edits";
import type { ManualSessionEdits, WeekdayLong, SessionPrescriptions, ExerciseOverrides } from "@/lib/data/types";
import type { SupabaseClient } from "@supabase/supabase-js";

const WEEKDAY_LONG_SET = new Set<string>([
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
]);

function isYmd(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function isMonday(ymd: string): boolean {
  // Parse as UTC noon to get the correct day-of-week without DST shift.
  const d = new Date(`${ymd}T12:00:00Z`);
  return d.getUTCDay() === 1;
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ week_start: string }> },
) {
  const { week_start } = await ctx.params;

  if (!isYmd(week_start)) {
    return NextResponse.json({ ok: false, error: "week_start must be YYYY-MM-DD" }, { status: 400 });
  }
  if (!isMonday(week_start)) {
    return NextResponse.json({ ok: false, error: "week_start must be a Monday" }, { status: 400 });
  }

  // Session auth.
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  // Confirm it's the CURRENT week's Monday in the user's timezone.
  const tz = await getUserTimezone(user.id);
  const todayIso = todayInUserTz(new Date(), tz);
  const thisMonday = currentWeekMonday(new Date(), tz);
  if (week_start !== thisMonday) {
    return NextResponse.json(
      { ok: false, error: `week_start must be the current week's Monday (${thisMonday})`, code: "not_current_week" },
      { status: 400 },
    );
  }

  // Parse body.
  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ ok: false, error: "body must be valid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ ok: false, error: "body must be an object" }, { status: 400 });
  }
  const b = body as Record<string, unknown>;

  if (typeof b.weekday !== "string" || !WEEKDAY_LONG_SET.has(b.weekday)) {
    return NextResponse.json(
      { ok: false, error: "weekday must be a full weekday name (Monday…Sunday)" },
      { status: 400 },
    );
  }
  const weekday = b.weekday as WeekdayLong;

  // edits: null | object
  const rawEdits = "edits" in b ? b.edits : undefined;
  if (rawEdits !== null && rawEdits !== undefined && typeof rawEdits !== "object") {
    return NextResponse.json({ ok: false, error: "edits must be an object or null" }, { status: 400 });
  }

  const sr = createSupabaseServiceRoleClient() as unknown as SupabaseClient;

  // Load the training_weeks row.
  const { data: row, error: loadErr } = await supabase
    .from("training_weeks")
    .select("session_plan, exercise_overrides, session_prescriptions, manual_session_edits")
    .eq("user_id", user.id)
    .eq("week_start", week_start)
    .maybeSingle();
  if (loadErr) {
    return NextResponse.json({ ok: false, error: `load failed: ${loadErr.message}` }, { status: 500 });
  }
  if (!row) {
    return NextResponse.json(
      { ok: false, error: `no training_weeks row for week_start=${week_start}`, code: "no_training_week" },
      { status: 404 },
    );
  }

  // Resolve the session type for the weekday.
  const sessionType = readSessionForDay(row.session_plan as Record<string, string>, weekday);
  if (!sessionType) {
    return NextResponse.json(
      { ok: false, error: `weekday=${weekday} has no session scheduled` },
      { status: 400 },
    );
  }

  // Resolve the base exercise list (WITHOUT manual layer) for validation.
  const resolved = await resolveSessionPlan({
    supabase: sr,
    userId: user.id,
    sessionType,
    weekdayLong: weekday,
    weekOverrides: (row.exercise_overrides as ExerciseOverrides | null) ?? null,
    weekPrescriptions: (row.session_prescriptions as SessionPrescriptions | null) ?? null,
    manualEdits: null,  // IMPORTANT: no manual layer for validation baseline
  });

  // Read-modify-write of manual_session_edits.
  const existing = (row.manual_session_edits as ManualSessionEdits | null) ?? {};

  let updated: ManualSessionEdits;
  if (rawEdits === null || rawEdits === undefined) {
    // Clear this weekday's entry.
    const { [weekday]: _removed, ...rest } = existing;
    updated = rest;
  } else {
    // Validate edits.
    const editsObj = rawEdits as { order?: string[]; exercises?: Record<string, { sets?: number; kg?: number; reps?: number }> };
    const validation = validateDayEdits(editsObj, resolved.exercises);
    if (!validation.ok) {
      return NextResponse.json({ ok: false, error: validation.error, code: "invalid_edits" }, { status: 422 });
    }
    updated = { ...existing, [weekday]: editsObj };
  }

  // Write NULL when empty, jsonb object otherwise.
  const newValue = Object.keys(updated).length === 0 ? null : updated;

  const { error: writeErr } = await sr
    .from("training_weeks")
    .update({ manual_session_edits: newValue, updated_at: new Date().toISOString() })
    .eq("user_id", user.id)
    .eq("week_start", week_start);
  if (writeErr) {
    return NextResponse.json({ ok: false, error: `write failed: ${writeErr.message}` }, { status: 500 });
  }

  // Return the updated resolved plan for the day (with edits applied) so the
  // client doesn't need a separate refetch.
  const dayEdits = newValue?.[weekday] ?? null;
  const { exercises: finalExercises } = applyManualSessionEdits(resolved.exercises, dayEdits);

  return NextResponse.json({
    ok: true,
    weekday,
    manual_session_edits: newValue,
    resolved_exercises: finalExercises,
  });
}
