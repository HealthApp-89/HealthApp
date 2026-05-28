// lib/coach/prescription/maintenance-baseline.ts
//
// Computes the "current working weight" for a lift — the highest clean set
// in the last N weeks where RPE ≤ rir_target + 1 (or RIR signal indicates
// clean). This is the value the maintenance multiplier (0.90×) applies to,
// NOT the stale SESSION_PLANS.baseKg.

import type { WorkoutSetSample } from "@/lib/coach/prescription/types";

const LOOKBACK_DAYS = 28; // 4 weeks
const MIN_REPS_FOR_BASELINE = 5;

/** Returns the max kg across the user's recent clean working sets for the
 *  given exercise. A set is "clean" if either:
 *   - rpe is non-null AND rpe ≤ (11 - rirTarget)
 *     (equivalently: rpe within 1 of the target RPE = 10 - rirTarget;
 *      e.g. rirTarget=2 → target RPE 8 → clean ≤ 9), OR
 *   - rir is non-null AND rir ≥ Math.max(0, rirTarget - 1)
 *  Both branches encode the same "within 1 unit of target effort" rule,
 *  expressed in whichever signal the set recorded.
 *  Returns null when no clean sets found in the window. */
export function maintenanceLoadFor(
  exerciseNameOrKey: string,
  rirTarget: number,
  recentSets: WorkoutSetSample[],
  todayIso: string,
): number | null {
  const cutoff = subtractDaysIso(todayIso, LOOKBACK_DAYS);
  const cleanSets = recentSets.filter((s) => {
    if (s.performed_on < cutoff) return false;
    if (s.exercise_name !== exerciseNameOrKey && s.exercise_key !== exerciseNameOrKey) return false;
    // Reject sub-hypertrophy-range singles/doubles — they bias the maintenance
    // baseline upward. Standard Israetel/Helms practice: working baselines from
    // 5+ rep sets only.
    if (s.reps < MIN_REPS_FOR_BASELINE) return false;
    const rpeOk  = s.rpe != null && s.rpe <= 11 - rirTarget;
    const rirOk  = s.rir != null && s.rir >= Math.max(0, rirTarget - 1);
    return rpeOk || rirOk;
  });
  if (cleanSets.length === 0) return null;
  return Math.max(...cleanSets.map((s) => s.kg));
}

function subtractDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
