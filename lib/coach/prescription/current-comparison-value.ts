// lib/coach/prescription/current-comparison-value.ts
//
// Helper consumed by prescribeWeek and framework-state: derives the
// "current value to compare against block.target_value" from the user's
// recent clean working sets, honoring the block's target_metric.
//
//   working_weight → max non-warmup kg in the maintenance window
//   e1rm           → max Brzycki e1RM across non-warmup sets in 1..12 reps
//
// Keeping the conversion in one place ensures the framework-state block
// Carter reads, the prescribeWeek output that lands in session_prescriptions,
// and the consolidation-triggering target-hit-evaluator all agree on what
// "current" means for a given block.

import type { PrimaryLift, TargetMetric } from "@/lib/data/types";
import type { WorkoutSetSample } from "@/lib/coach/prescription/types";
import { bestComparisonValue } from "@/lib/coach/e1rm";
import { maintenanceLoadFor } from "@/lib/coach/prescription/maintenance-baseline";

/** Recent-set name patterns per primary lift. Mirrors prescribe-week.ts /
 *  target-hit-evaluator.ts. The single source-of-truth idea applies here too:
 *  any change to recognized primary-lift names lands in all three files. */
export const PRIMARY_LIFT_NAME_PATTERNS: Record<PrimaryLift, string[]> = {
  squat:    ["Squat (Barbell)"],
  bench:    ["Decline Bench Press (Barbell)", "Incline Bench Press (Dumbbell)", "Bench Press (Barbell)"],
  deadlift: ["Deadlift (Barbell)"],
  ohp:      ["Overhead Press (Barbell)"],
};

/** Resolve the current comparison value for `lift` matched to `metric`,
 *  scanning the recent-sets sample (already filtered to the maintenance
 *  window by the caller). Returns null when no usable set exists.
 *
 *  Implementation notes:
 *   - For working_weight we still use maintenanceLoadFor (RIR-clean window)
 *     to stay consistent with the rest of the rule engine's load semantics.
 *   - For e1rm we take the max Brzycki across ALL non-warmup recent sets in
 *     the 1..12 rep window — the e1RM signal is strongest at near-failure
 *     attempts, even if they aren't RIR-clean working sets. */
export function currentComparisonValueForLift(opts: {
  lift: PrimaryLift;
  metric: TargetMetric;
  recentSets: WorkoutSetSample[];
  rirTarget: number;
  todayIso: string;
}): number | null {
  const { lift, metric, recentSets, rirTarget, todayIso } = opts;
  const names = PRIMARY_LIFT_NAME_PATTERNS[lift];
  if (!names || names.length === 0) return null;

  if (metric === "working_weight") {
    for (const n of names) {
      const m = maintenanceLoadFor(n, rirTarget, recentSets, todayIso);
      if (m != null) return m;
    }
    return null;
  }

  // e1rm — collect all non-warmup sets for this lift, take Brzycki max
  const lowerNames = new Set(names.map((n) => n.toLowerCase()));
  const candidate = recentSets.filter(
    (s) => !s.warmup && lowerNames.has(s.exercise_name.toLowerCase()),
  );
  return bestComparisonValue(candidate, "e1rm");
}
