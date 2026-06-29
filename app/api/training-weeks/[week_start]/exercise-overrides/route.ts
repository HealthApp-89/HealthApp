// app/api/training-weeks/[week_start]/exercise-overrides/route.ts
//
// Persist a per-day exercise reorder. Permutation-only: the submitted list
// must contain the same set of exercise names as the static
// SESSION_PLANS[session_plan[weekday]] for that day. PlannedExercise fields
// (sets/reps/baseKg/etc.) are carried as-submitted; we do not re-merge with
// the static plan.
//
// Body: { weekday: "Monday"..., exercises: PlannedExercise[] }

import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SESSION_PLANS, type PlannedExercise } from "@/lib/coach/sessionPlans";
import { readSessionForDay } from "@/lib/coach/session-plan-reader";
import type { ExerciseOverrides, SessionPrescriptions } from "@/lib/data/types";

const FULL_WEEKDAYS = new Set([
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
]);

function isYmd(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function asExercise(x: unknown): PlannedExercise | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  if (typeof o.name !== "string" || o.name.length === 0) return null;
  // Permissive — only name is required at the type level. The static plan
  // dictates which optional fields are present; we carry whatever was sent.
  return o as PlannedExercise;
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ week_start: string }> },
) {
  const { week_start } = await ctx.params;
  if (!isYmd(week_start)) {
    return NextResponse.json(
      { ok: false, error: "week_start must be YYYY-MM-DD" },
      { status: 400 },
    );
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "body must be valid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ ok: false, error: "body must be an object" }, { status: 400 });
  }
  const b = body as Record<string, unknown>;
  if (typeof b.weekday !== "string" || !FULL_WEEKDAYS.has(b.weekday)) {
    return NextResponse.json(
      { ok: false, error: "weekday must be a full weekday name (Monday..Sunday)" },
      { status: 400 },
    );
  }
  if (!Array.isArray(b.exercises)) {
    return NextResponse.json(
      { ok: false, error: "exercises must be an array" },
      { status: 400 },
    );
  }
  const exercises: PlannedExercise[] = [];
  for (const item of b.exercises) {
    const ex = asExercise(item);
    if (!ex) {
      return NextResponse.json(
        { ok: false, error: "each exercise must be an object with a non-empty name" },
        { status: 400 },
      );
    }
    exercises.push(ex);
  }

  const weekday = b.weekday;

  // Load the row.
  const { data: row, error: loadErr } = await supabase
    .from("training_weeks")
    .select("session_plan, exercise_overrides, session_prescriptions")
    .eq("user_id", user.id)
    .eq("week_start", week_start)
    .maybeSingle();
  if (loadErr) {
    return NextResponse.json(
      { ok: false, error: `load failed: ${loadErr.message}` },
      { status: 500 },
    );
  }
  if (!row) {
    return NextResponse.json(
      { ok: false, error: `no training_weeks row for week_start=${week_start}` },
      { status: 404 },
    );
  }

  // Resolve session type for the weekday — session_plan keys may be short or
  // full form (per session-plan-reader.ts).
  const sessionType = readSessionForDay(row.session_plan as Record<string, string>, weekday);
  if (!sessionType || sessionType === "REST") {
    return NextResponse.json(
      { ok: false, error: `weekday=${weekday} is REST or not scheduled — nothing to reorder` },
      { status: 400 },
    );
  }
  const staticPlan = SESSION_PLANS[sessionType] ?? [];
  if (staticPlan.length === 0) {
    return NextResponse.json(
      { ok: false, error: `unknown session type "${sessionType}"` },
      { status: 400 },
    );
  }

  // Validate the permutation against what the athlete actually sees, i.e. the
  // effective exercise list: prescription for the day (top of the resolution
  // chain) → existing override → static plan. Using staticPlan unconditionally
  // would reject a valid reorder whenever the Sunday engine prescribed a name
  // set that diverges from SESSION_PLANS.
  const existing = (row.exercise_overrides ?? {}) as ExerciseOverrides;
  const prescriptions = (row.session_prescriptions ?? null) as SessionPrescriptions | null;
  const prescForDay = prescriptions?.[weekday as keyof SessionPrescriptions];
  const baselineExercises =
    prescForDay && prescForDay.length > 0
      ? prescForDay
      : existing?.[weekday] ?? staticPlan;
  if (exercises.length !== baselineExercises.length) {
    return NextResponse.json(
      {
        ok: false,
        error: `expected ${baselineExercises.length} exercises, got ${exercises.length}`,
      },
      { status: 400 },
    );
  }
  const baselineNames = baselineExercises.map((e) => e.name).sort();
  const submittedNames = exercises.map((e) => e.name).sort();
  for (let i = 0; i < baselineNames.length; i++) {
    if (baselineNames[i] !== submittedNames[i]) {
      return NextResponse.json(
        {
          ok: false,
          error: `permutation only — submitted names do not match current exercises for ${weekday}`,
        },
        { status: 400 },
      );
    }
  }

  // Upsert the weekday slot in the override map.
  const next: ExerciseOverrides = { ...existing, [weekday]: exercises };

  const { error: updateErr } = await supabase
    .from("training_weeks")
    .update({ exercise_overrides: next, updated_at: new Date().toISOString() })
    .eq("user_id", user.id)
    .eq("week_start", week_start);
  if (updateErr) {
    return NextResponse.json(
      { ok: false, error: `update failed: ${updateErr.message}` },
      { status: 500 },
    );
  }

  revalidatePath("/");
  revalidatePath("/coach");

  return NextResponse.json({ ok: true, exercise_overrides: next });
}
