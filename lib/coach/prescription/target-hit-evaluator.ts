// lib/coach/prescription/target-hit-evaluator.ts
//
// On every workout commit, check whether the user's primary lift in the
// active block has crossed target_value. If so, set target_hit_at_week
// (idempotent — no-op when already set). This is the consolidation
// forcing function — once stamped, propose_week_plan refuses further
// load increases for the lift.

import type { SupabaseClient } from "@supabase/supabase-js";

/** Exercise-name patterns that identify a primary-lift instance.
 *  Mirrors prescribe-week.ts. */
const PRIMARY_LIFT_NAME_PATTERNS: Record<string, string[]> = {
  squat:    ["Squat (Barbell)"],
  bench:    ["Decline Bench Press (Barbell)", "Incline Bench Press (Dumbbell)", "Bench Press (Barbell)"],
  deadlift: ["Deadlift (Barbell)"],
  ohp:      ["Overhead Press (Barbell)"],
};

export async function evaluateAndStampTargetHit(opts: {
  supabase: SupabaseClient;
  userId: string;
}): Promise<{ stamped: boolean; week_n: number | null }> {
  const { supabase, userId } = opts;

  // Find active block
  const { data: blocks } = await supabase
    .from("training_blocks")
    .select("id, primary_lift, target_value, target_unit, start_date, end_date, target_hit_at_week")
    .eq("user_id", userId)
    .eq("status", "active")
    .limit(1);

  const block = blocks?.[0];
  if (!block || block.primary_lift == null || block.target_value == null || block.target_hit_at_week != null) {
    return { stamped: false, week_n: null };
  }

  const namePatterns = PRIMARY_LIFT_NAME_PATTERNS[block.primary_lift];
  if (!namePatterns || namePatterns.length === 0) return { stamped: false, week_n: null };

  // Find the max working-set kg for the primary lift since block start.
  // Query workouts → exercises → exercise_sets in one round-trip via nested
  // select, filtering by user_id + date range + warmup=false.
  const { data: workouts, error } = await supabase
    .from("workouts")
    .select("date, exercises(name, exercise_sets(kg, reps, warmup, failure))")
    .eq("user_id", userId)
    .gte("date", block.start_date)
    .lte("date", block.end_date);

  if (error || !workouts) return { stamped: false, week_n: null };

  type RawSet = { kg: number | null; reps: number | null; warmup: boolean | null; failure: boolean | null };
  type RawEx = { name: string; exercise_sets: RawSet[] | null };
  type RawW = { date: string; exercises: RawEx[] | null };

  const rows = workouts as unknown as RawW[];
  const patternsLower = namePatterns.map((p) => p.toLowerCase());

  let maxKg = 0;
  for (const w of rows) {
    for (const ex of w.exercises ?? []) {
      if (!patternsLower.includes(ex.name.toLowerCase())) continue;
      for (const s of ex.exercise_sets ?? []) {
        if (s.warmup) continue;
        if (s.kg != null && s.kg > maxKg) maxKg = s.kg;
      }
    }
  }

  if (maxKg < block.target_value) return { stamped: false, week_n: null };

  // Determine block-week index (1-indexed) from block.start_date
  const start = new Date(block.start_date + "T00:00:00Z");
  const today = new Date();
  const weekN = Math.max(
    1,
    Math.floor((today.getTime() - start.getTime()) / (7 * 24 * 60 * 60 * 1000)) + 1,
  );

  // Optimistic stamp: only set if still null (idempotent against concurrent commits)
  await supabase
    .from("training_blocks")
    .update({ target_hit_at_week: weekN, updated_at: new Date().toISOString() })
    .eq("id", block.id)
    .is("target_hit_at_week", null);

  return { stamped: true, week_n: weekN };
}
