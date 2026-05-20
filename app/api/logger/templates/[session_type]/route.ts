// app/api/logger/templates/[session_type]/route.ts
//
// PUT  /api/logger/templates/[session_type]
//   Upserts the per-user persistent override (the "save deviations as my
//   default" layer between training_weeks.exercise_overrides and
//   SESSION_PLANS). Body: { exercises: PlannedExercise[] }.
//
// DELETE /api/logger/templates/[session_type]
//   Removes the override, falling back to SESSION_PLANS for this session_type.
//
// Both endpoints are cookie-bound and RLS-respecting; RLS already enforces
// per-user scoping but we still pass user_id explicitly so the upsert key
// is stable.

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";

type Ctx = { params: Promise<{ session_type: string }> };

export async function PUT(req: Request, { params }: Ctx) {
  const { session_type } = await params;
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  let body: { exercises: PlannedExercise[] };
  try {
    body = (await req.json()) as { exercises: PlannedExercise[] };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!Array.isArray(body.exercises) || body.exercises.length === 0) {
    return NextResponse.json({ error: "exercises must be a non-empty array" }, { status: 400 });
  }

  // Explicit updated_at: addresses the Task 1 reviewer note that the
  // default-on-insert would never advance after the first save.
  const { error } = await supabase
    .from("user_session_templates")
    .upsert(
      {
        user_id: user.id,
        session_type,
        exercises: body.exercises,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,session_type" },
    );

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { session_type } = await params;
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { error } = await supabase
    .from("user_session_templates")
    .delete()
    .eq("user_id", user.id)
    .eq("session_type", session_type);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
