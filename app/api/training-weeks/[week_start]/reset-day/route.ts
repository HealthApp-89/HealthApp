// Reset a specific weekday's exercise overrides to use the static plan.
// POST /api/training-weeks/[week_start]/reset-day
// Body: { weekday: "Monday" }

import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { ExerciseOverrides } from "@/lib/data/types";

const FULL_WEEKDAYS = new Set([
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
]);

function isYmd(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
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
  const weekday = b.weekday as string;
  if (typeof weekday !== "string" || !FULL_WEEKDAYS.has(weekday)) {
    return NextResponse.json(
      { ok: false, error: "weekday must be a full weekday name (Monday..Sunday)" },
      { status: 400 },
    );
  }

  // Load the row.
  const { data: row, error: loadErr } = await supabase
    .from("training_weeks")
    .select("exercise_overrides")
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

  // Remove the weekday from overrides.
  const existing = (row.exercise_overrides as ExerciseOverrides | null) ?? ({} as ExerciseOverrides);
  const next: ExerciseOverrides = { ...existing };
  delete next[weekday];

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

  return NextResponse.json({ ok: true, message: `${weekday} reset to static plan` });
}
