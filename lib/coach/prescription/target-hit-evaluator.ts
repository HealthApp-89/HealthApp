// lib/coach/prescription/target-hit-evaluator.ts
//
// On every workout commit, check whether the user's primary lift in the
// active block has crossed target_value. If so, set target_hit_at_week
// (idempotent — no-op when already set). This is the consolidation
// forcing function — once stamped, propose_week_plan refuses further
// load increases for the lift.
//
// Comparison metric honors `training_blocks.target_metric`:
//   'working_weight' → max raw non-warmup kg across the block window
//   'e1rm'           → max Brzycki e1RM across non-warmup sets in 1..12 reps
//   null (legacy)    → defaults to 'working_weight' for backwards compatibility

import type { SupabaseClient } from "@supabase/supabase-js";
import type { TargetMetric } from "@/lib/data/types";
import { bestComparisonValue } from "@/lib/coach/e1rm";

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

  // Find active block. target_metric is read so the comparison honors
  // whether the target is an e1RM contract or a raw working-weight contract.
  const { data: blocks } = await supabase
    .from("training_blocks")
    .select("id, primary_lift, target_value, target_metric, target_unit, start_date, end_date, target_hit_at_week")
    .eq("user_id", userId)
    .eq("status", "active")
    .limit(1);

  const block = blocks?.[0];
  if (!block || block.primary_lift == null || block.target_value == null || block.target_hit_at_week != null) {
    return { stamped: false, week_n: null };
  }

  const namePatterns = PRIMARY_LIFT_NAME_PATTERNS[block.primary_lift];
  if (!namePatterns || namePatterns.length === 0) return { stamped: false, week_n: null };

  // Find the best comparison value (working_weight or e1RM per target_metric)
  // for the primary lift since block start.
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

  const candidateSets: Array<{ kg: number | null; reps: number | null; warmup: boolean | null }> = [];
  for (const w of rows) {
    for (const ex of w.exercises ?? []) {
      if (!patternsLower.includes(ex.name.toLowerCase())) continue;
      for (const s of ex.exercise_sets ?? []) {
        candidateSets.push({ kg: s.kg, reps: s.reps, warmup: s.warmup });
      }
    }
  }

  // Legacy rows pre-0041 may have NULL target_metric. Default to working_weight
  // to keep their consolidation semantics unchanged until they're migrated.
  const metric: TargetMetric = (block.target_metric as TargetMetric | null) ?? "working_weight";
  const best = bestComparisonValue(candidateSets, metric);
  if (best == null || best < block.target_value) return { stamped: false, week_n: null };

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
