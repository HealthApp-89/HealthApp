// app/api/training-weeks/[week_start]/activities/route.ts
//
// PUT → replace training_weeks.planned_activities for the given week.
// Body: PlannedActivity[] (Zod-validated).
// DELETE a single activity by matching date + type: body { date, type }.
//
// Auth: session-auth (RLS-respecting server client). The user_id comes from
// the authenticated session — no body field.
//
// Mirrors the exercise-overrides write route for the auth + upsert pattern.

import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  PlannedActivitySchema,
} from "@/lib/coach/activity/types";

function isYmd(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

const BodySchema = z.array(PlannedActivitySchema);

// PUT — replace the full planned_activities array for the week.
export async function PUT(
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

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "body must be valid JSON" }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "validation_failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const activities = parsed.data;

  // Upsert the row — insert if it doesn't exist, update planned_activities if
  // it does. training_weeks rows are created by the weekly-planning flow; we
  // allow writes to non-existent rows so the UI can log activities without
  // first setting up a formal plan.
  const { error: upsertErr } = await supabase
    .from("training_weeks")
    .upsert(
      {
        user_id: user.id,
        week_start,
        planned_activities: activities,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,week_start", ignoreDuplicates: false },
    );

  if (upsertErr) {
    console.error("[/api/training-weeks/.../activities] upsert failed", upsertErr);
    return NextResponse.json(
      { ok: false, error: `upsert failed: ${upsertErr.message}` },
      { status: 500 },
    );
  }

  revalidatePath("/");
  revalidatePath("/coach");
  revalidatePath("/strength");

  return NextResponse.json({ ok: true, planned_activities: activities });
}

// DELETE — remove a single activity identified by date + type.
export async function DELETE(
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

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "body must be valid JSON" }, { status: 400 });
  }

  const b = rawBody as Record<string, unknown>;
  if (!isYmd(b.date) || typeof b.type !== "string") {
    return NextResponse.json(
      { ok: false, error: "body must include {date: YYYY-MM-DD, type: string}" },
      { status: 400 },
    );
  }
  const { date, type } = b;

  // Load existing row.
  const { data: row, error: loadErr } = await supabase
    .from("training_weeks")
    .select("planned_activities")
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
    return NextResponse.json({ ok: true, planned_activities: [] });
  }

  const existing = (row.planned_activities ?? []) as Array<Record<string, unknown>>;
  // Remove the first matching entry (date + type).
  let removed = false;
  const next = existing.filter((a) => {
    if (!removed && a.date === date && a.type === type) {
      removed = true;
      return false;
    }
    return true;
  });

  const { error: updateErr } = await supabase
    .from("training_weeks")
    .update({ planned_activities: next, updated_at: new Date().toISOString() })
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
  revalidatePath("/strength");

  return NextResponse.json({ ok: true, planned_activities: next });
}
