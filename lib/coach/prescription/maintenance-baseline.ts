// lib/coach/prescription/maintenance-baseline.ts
//
// Computes the "current working weight" for a lift — the highest kg across
// recent clean working sets. A "clean" set is one the lifter completed
// without grinding to failure or treating it as warmup. RPE/RIR signals are
// NOT tracked in this codebase's schema (exercise_sets has no rpe/rir
// columns); we derive working capacity from reps + warmup + failure flags.

import type { WorkoutSetSample } from "@/lib/coach/prescription/types";

const LOOKBACK_DAYS = 28; // 4 weeks
const MIN_REPS_FOR_BASELINE = 5; // hypertrophy-range floor; rejects singles/doubles that bias the baseline

/** Returns the max kg across the user's recent clean working sets for the
 *  given exercise. A set is "clean" if all of:
 *   - performed_on within the lookback window
 *   - warmup === false
 *   - failure === false
 *   - reps >= MIN_REPS_FOR_BASELINE (hypertrophy-range floor)
 *  Returns null when no clean sets found in the window.
 *
 *  The rirTarget parameter is accepted for API symmetry with other rule
 *  modules but is not used in the filter (rpe/rir columns don't exist in
 *  the schema). Future migrations could enable rpe-based filtering. */
export function maintenanceLoadFor(
  exerciseNameOrKey: string,
  rirTarget: number,
  recentSets: WorkoutSetSample[],
  todayIso: string,
): number | null {
  void rirTarget; // reserved for future RPE-aware filtering
  const cutoff = subtractDaysIso(todayIso, LOOKBACK_DAYS);
  const cleanSets = recentSets.filter((s) => {
    if (s.performed_on < cutoff) return false;
    if (s.exercise_name !== exerciseNameOrKey && s.exercise_key !== exerciseNameOrKey) return false;
    if (s.warmup) return false;
    if (s.failure) return false;
    if (s.reps < MIN_REPS_FOR_BASELINE) return false;
    return true;
  });
  if (cleanSets.length === 0) return null;
  return Math.max(...cleanSets.map((s) => s.kg));
}

function subtractDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
