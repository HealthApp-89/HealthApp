// app/api/coach/workout-debrief/route.ts
//
// Client-fired endpoint called by LoggerSheet after commit_logger_session
// succeeds. Idempotent on workout_id: re-firing returns the existing
// chat_message_id without regenerating.

import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { generateWorkoutDebrief } from "@/lib/coach/session-debrief";
import { tldrFromPayload } from "@/lib/coach/session-debrief/payload";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  // Auth via cookie-bound client (RLS-respecting). Service-role is only used
  // for the heavy DB reads inside generateWorkoutDebrief (private to this
  // route — never exposed to the client).
  const userClient = await createSupabaseServerClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { workout_id?: string };
  try {
    body = (await req.json()) as { workout_id?: string };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const workoutId = body.workout_id;
  if (!workoutId) {
    return NextResponse.json({ error: "workout_id required" }, { status: 400 });
  }

  const sr = createSupabaseServiceRoleClient();

  // Confirm the workout belongs to this user — defense in depth alongside
  // the eq("user_id", user.id) inside the orchestrator.
  const { data: workout, error: wErr } = await sr
    .from("workouts")
    .select("id, user_id")
    .eq("id", workoutId)
    .maybeSingle();
  if (wErr) return NextResponse.json({ error: wErr.message }, { status: 500 });
  if (!workout || workout.user_id !== user.id) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Idempotency check using the partial index from migration 0032.
  const { data: existing, error: lookupErr } = await sr
    .from("chat_messages")
    .select("id")
    .eq("user_id", user.id)
    .eq("kind", "workout_debrief")
    .eq("ui->>workout_id", workoutId)
    .maybeSingle();
  if (lookupErr) {
    return NextResponse.json({ error: lookupErr.message }, { status: 500 });
  }
  if (existing) {
    return NextResponse.json({ ok: true, chat_message_id: existing.id, idempotent: true });
  }

  // Generate.
  let result;
  try {
    result = await generateWorkoutDebrief({
      supabase: sr,
      userId: user.id,
      workoutId,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "generate_failed", detail: msg }, { status: 500 });
  }
  if (!result.ok) {
    return NextResponse.json({ ok: true, skipped: result.skipped });
  }

  const { payload } = result;
  const tldr = tldrFromPayload(payload);

  const { data: inserted, error: insertErr } = await sr
    .from("chat_messages")
    .insert({
      user_id: user.id,
      role: "assistant",
      speaker: "carter",
      thread: "carter",
      kind: "workout_debrief",
      content: tldr,
      ui: payload,
    })
    .select("id")
    .single();
  if (insertErr || !inserted) {
    return NextResponse.json(
      { error: "insert_failed", detail: insertErr?.message ?? "no row" },
      { status: 500 },
    );
  }

  revalidatePath("/coach");
  revalidatePath(`/coach/sessions/${workoutId}`);

  return NextResponse.json({ ok: true, chat_message_id: inserted.id });
}
