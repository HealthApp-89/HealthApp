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
import { blockWeekOf } from "@/lib/coach/prescription/block-week";

/** Exercise-name patterns that identify a primary-lift instance.
 *  Mirrors prescribe-week.ts. */
export const PRIMARY_LIFT_NAME_PATTERNS: Record<string, string[]> = {
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

  // Legacy rows pre-0041 may have NULL target_metric. Default to working_weight
  // to keep their consolidation semantics unchanged until they're migrated.
  const metric: TargetMetric = (block.target_metric as TargetMetric | null) ?? "working_weight";

  // Group by session date so the crossing can be attributed to the session
  // that produced it. Flattening across dates loses that, and the block week
  // then has to be guessed from "now".
  const perDate: Array<{ date: string; best: number | null }> = [];
  for (const w of rows) {
    const sets: Array<{ kg: number | null; reps: number | null; warmup: boolean | null }> = [];
    for (const ex of w.exercises ?? []) {
      if (!patternsLower.includes(ex.name.toLowerCase())) continue;
      for (const s of ex.exercise_sets ?? []) {
        sets.push({ kg: s.kg, reps: s.reps, warmup: s.warmup });
      }
    }
    if (sets.length > 0) perDate.push({ date: w.date, best: bestComparisonValue(sets, metric) });
  }

  const qualifyingDate = pickQualifyingDate(perDate, block.target_value);
  if (qualifyingDate === null) return { stamped: false, week_n: null };

  // Block-week index (1-indexed) of the session that crossed the target.
  const weekN = blockWeekOf(block.start_date, qualifyingDate);

  // Optimistic stamp: only set if still null (idempotent against concurrent commits)
  await supabase
    .from("training_blocks")
    .update({ target_hit_at_week: weekN, updated_at: new Date().toISOString() })
    .eq("id", block.id)
    .is("target_hit_at_week", null);

  return { stamped: true, week_n: weekN };
}

/** Earliest date whose best comparison value meets the target, or null.
 *  The crossing happened on that date — deriving the block week from it
 *  (rather than from "now") is what makes target_hit_at_week a function of
 *  the data, and therefore restorable after a session is unwound. */
export function pickQualifyingDate(
  perDate: ReadonlyArray<{ date: string; best: number | null }>,
  target: number,
): string | null {
  let earliest: string | null = null;
  for (const d of perDate) {
    if (d.best == null || d.best < target) continue;
    if (earliest === null || d.date < earliest) earliest = d.date;
  }
  return earliest;
}
