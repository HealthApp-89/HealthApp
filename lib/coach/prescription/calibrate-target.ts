// lib/coach/prescription/calibrate-target.ts
//
// Trend-derived block-target recommendation + sanity bounds.
//
// Two phases:
//   1. Pure helpers (this file's exports) — coefficient lookup, OLS slope,
//      grid rounding, sanity-bounds computation. No I/O.
//   2. Supabase-driven orchestrator computeTargetRecommendation() that pulls
//      90d of realized working sets and feeds the pure helpers.
//
// Used by executeProposeBlock to reject obviously-miscalibrated targets and
// by fetchSetupBlockContext to surface the recommendation to Carter's prompt.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PrimaryLift } from "@/lib/data/types";
import { bestComparisonValue } from "@/lib/coach/e1rm";
import { PRIMARY_LIFT_NAME_PATTERNS } from "@/lib/coach/prescription/current-comparison-value";

export type AthletePhase = "bulk" | "maintenance" | "cut";

/** Realistic e1RM kg/wk gain on a FOCUS lift for an intermediate male
 *  athlete. Numbers triangulated from Wendler 5/3/1 cycle deltas
 *  (5 lb upper / 10 lb lower per 3-week cycle), Helms 3DMJ intermediate
 *  cut protocols, and Stronger-by-Science training-progression reviews.
 *  Conservative — these target "realistic if execution is clean", not
 *  best-case. Revisit if/when literature updates. */
export const COEFFICIENT_TABLE: Record<PrimaryLift, Record<AthletePhase, number>> = {
  deadlift: { bulk: 2.5, maintenance: 1.5, cut: 1.5 },
  squat:    { bulk: 2.0, maintenance: 1.25, cut: 1.25 },
  bench:    { bulk: 1.0, maintenance: 0.75, cut: 0.75 },
  ohp:      { bulk: 0.75, maintenance: 0.4, cut: 0.4 },
};

/** All four primary lifts are barbell-loaded in the current exercise library,
 *  so the grid step is uniform 2.5 kg. Hard-coded rather than fetched per-lift
 *  to keep this module pure + cheap. */
const GRID_STEP_KG = 2.5;

/** Round DOWN to the nearest grid step. Used so recommended/sanity targets
 *  never propose a load that isn't on the equipment grid. */
export function gridRoundDown(kg: number): number {
  return Math.floor(kg / GRID_STEP_KG) * GRID_STEP_KG;
}

/** Round UP to nearest grid step. Used for the lower sanity bound so the
 *  rejection window can never wrap a valid grid value the athlete might enter. */
export function gridRoundUp(kg: number): number {
  return Math.ceil(kg / GRID_STEP_KG) * GRID_STEP_KG;
}

/** OLS slope of (weekIndex, e1rm) across the supplied per-week max samples.
 *  Returns null when fewer than 3 weeks of data — the slope is statistically
 *  meaningless below that. weekIndices must be 0-indexed and monotonically
 *  increasing; the caller decides whether to fill gaps. */
export function computeOlsSlope(
  samples: ReadonlyArray<{ weekIndex: number; e1rm: number }>,
): number | null {
  if (samples.length < 3) return null;
  const n = samples.length;
  const sumX = samples.reduce((a, s) => a + s.weekIndex, 0);
  const sumY = samples.reduce((a, s) => a + s.e1rm, 0);
  const sumXY = samples.reduce((a, s) => a + s.weekIndex * s.e1rm, 0);
  const sumXX = samples.reduce((a, s) => a + s.weekIndex * s.weekIndex, 0);
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;
  return (n * sumXY - sumX * sumY) / denom;
}

/** Compute the sanity-bounds window for a proposed target, given the
 *  athlete's current e1RM and the lift's phase coefficient. The lower bound
 *  rejects "too easy" (target hit by week 1); the upper bound rejects
 *  "demoralizing/unrealistic" at 1.5× the realistic 4-week gain. */
export function computeSanityBounds(opts: {
  currentE1rm: number;
  coefficient: number;
}): [number, number] {
  const lower = gridRoundUp(opts.currentE1rm + 1);
  const upper = gridRoundDown(opts.currentE1rm + opts.coefficient * 4 * 1.5);
  return [lower, upper];
}

/** Coefficient lookup with safe fallback. NULL phase defaults to 'cut' to
 *  match the default the rest of the prescription pipeline assumes when
 *  plan_payload isn't available. */
export function coefficientFor(lift: PrimaryLift, phase: AthletePhase = "cut"): number {
  return COEFFICIENT_TABLE[lift][phase];
}

// ── Supabase-driven orchestrator (Task 2) ────────────────────────────────
// computeTargetRecommendation() is implemented in Task 2.
