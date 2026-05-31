// lib/coach/e1rm.ts
//
// Single source of truth for e1RM (estimated 1-rep max) math. The block-target
// framework supports two `target_metric` values on training_blocks:
//
//   'working_weight' — compare the athlete's heaviest non-warmup working set
//     (raw kg) against `target_value`. This is the legacy comparison.
//   'e1rm'           — convert each non-warmup set to its e1RM via Brzycki and
//                      compare the maximum e1RM against `target_value`.
//
// Brzycki is the default per the original block-target contract (target_value
// stored in kg as an e1RM, e.g. "deadlift e1RM 115 kg by Jun 14"). Epley is
// exposed for callers that need the slightly more conservative estimate at
// high rep counts.
//
// Both formulas reject reps outside the 1-12 range — above 12 reps the
// linear extrapolation breaks down (e1RM becomes unreliable as a strength
// proxy). Sub-1-rep is impossible. Callers must check the return is non-null
// before consuming the value.

import type { TargetMetric } from "@/lib/data/types";

/** Brzycki 1RM formula: 1RM = kg × 36 / (37 − reps). Valid for 1..12 reps.
 *  Returns null for reps outside that range. */
export function brzycki(kg: number, reps: number): number | null {
  if (kg <= 0) return null;
  if (!Number.isFinite(reps) || reps < 1 || reps > 12) return null;
  return (kg * 36) / (37 - reps);
}

/** Epley 1RM formula: 1RM = kg × (1 + reps/30). Valid for 1..12 reps.
 *  Returns null for reps outside that range. Slightly more conservative than
 *  Brzycki at low reps, more aggressive at high reps. */
export function epley(kg: number, reps: number): number | null {
  if (kg <= 0) return null;
  if (!Number.isFinite(reps) || reps < 1 || reps > 12) return null;
  return kg * (1 + reps / 30);
}

/** Resolve "best comparison value" for a stream of working sets against a
 *  block's target. Caller must pre-filter warmups. Returns:
 *   - target_metric='working_weight': max raw kg across non-warmup sets
 *   - target_metric='e1rm':           max Brzycki e1RM across non-warmup sets
 *                                     in the valid 1..12 rep window
 *  Returns null when the input is empty or no set yields a valid value. */
export function bestComparisonValue(
  sets: ReadonlyArray<{ kg: number | null; reps: number | null; warmup?: boolean | null }>,
  target_metric: TargetMetric,
): number | null {
  let best: number | null = null;
  for (const s of sets) {
    if (s.warmup) continue;
    if (s.kg == null || s.kg <= 0) continue;
    if (s.reps == null || s.reps < 1) continue;
    let value: number | null;
    if (target_metric === "e1rm") {
      value = brzycki(s.kg, s.reps);
    } else {
      value = s.kg;
    }
    if (value == null) continue;
    if (best == null || value > best) best = value;
  }
  return best;
}

/** Human-readable suffix for narration. e.g. "kg (e1RM)" vs "kg working set".
 *  Carter / framework-state inject this so the athlete always sees which
 *  metric is being compared. */
export function metricLabel(target_metric: TargetMetric | null): string {
  if (target_metric === "e1rm") return "kg (e1RM)";
  if (target_metric === "working_weight") return "kg (working set)";
  return "kg"; // legacy rows: metric not specified
}
