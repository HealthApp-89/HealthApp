// app/api/coach/debrief/sweep/route.ts
//
// Hourly cron backstop for the client-fired workout debrief. Finds logger
// workouts in the last 48h with no matching chat_messages.kind='workout_debrief'
// row and runs the existing debrief generator for each.
//
// Idempotent by construction: the SELECT excludes workouts that already have
// a debrief row. A race between two sweeps (shouldn't happen — single Vercel
// cron entry) would still be safe because the chat_messages insert is
// transactional and a duplicate would simply be a second row tagged with the
// same workout_id (still distinguishable; not a correctness bug, just noise).
// We add the existence check inside the loop to guard against that anyway.

import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { generateWorkoutDebrief } from "@/lib/coach/session-debrief";
import { tldrFromPayload } from "@/lib/coach/session-debrief/payload";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // sweep multiple workouts in one invocation

type SweepResult = {
  swept: number;
  generated: number;
  skipped: number;
  errors: { workout_id: string; message: string }[];
};

export async function GET(req: Request) {
  // Vercel cron calls GET with `Authorization: Bearer ${CRON_SECRET}`.
  const auth = req.headers.get("authorization") ?? "";
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || !auth.startsWith("Bearer ") || auth.slice(7) !== cronSecret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sr = createSupabaseServiceRoleClient();
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  // Pull logger workouts from the last 48h. External_id filter narrows to
  // the in-app logger source (Strong CSV uses `strong-<date>-<slug>`).
  const { data: candidates, error: candErr } = await sr
    .from("workouts")
    .select("id, user_id, external_id, created_at")
    .gte("created_at", cutoff)
    .like("external_id", "logger-%");
  if (candErr) {
    return NextResponse.json({ error: candErr.message }, { status: 500 });
  }

  const result: SweepResult = {
    swept: candidates?.length ?? 0,
    generated: 0,
    skipped: 0,
    errors: [],
  };

  for (const workout of candidates ?? []) {
    // Idempotency check: does a debrief row already exist for this workout?
    const { data: existing, error: lookupErr } = await sr
      .from("chat_messages")
      .select("id")
      .eq("user_id", workout.user_id)
      .eq("kind", "workout_debrief")
      .eq("ui->>workout_id", workout.id)
      .maybeSingle();
    if (lookupErr) {
      result.errors.push({
        workout_id: workout.id,
        message: `lookup: ${lookupErr.message}`,
      });
      continue;
    }
    if (existing) {
      result.skipped += 1;
      continue;
    }

    // Generate.
    let genResult;
    try {
      genResult = await generateWorkoutDebrief({
        supabase: sr,
        userId: workout.user_id,
        workoutId: workout.id,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push({ workout_id: workout.id, message: `generate: ${msg}` });
      continue;
    }
    if (!genResult.ok) {
      result.skipped += 1;
      continue;
    }

    const tldr = tldrFromPayload(genResult.payload);
    const { error: insertErr } = await sr
      .from("chat_messages")
      .insert({
        user_id: workout.user_id,
        role: "assistant",
        speaker: "carter",
        thread: "carter",
        kind: "workout_debrief",
        content: tldr,
        ui: genResult.payload,
      });
    if (insertErr) {
      result.errors.push({
        workout_id: workout.id,
        message: `insert: ${insertErr.message}`,
      });
      continue;
    }

    revalidatePath("/coach");
    revalidatePath(`/coach/sessions/${workout.id}`);
    result.generated += 1;
  }

  return NextResponse.json(result);
}
