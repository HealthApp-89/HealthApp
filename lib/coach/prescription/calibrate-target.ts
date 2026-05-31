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
 *  "demoralizing/unrealistic" at 1.5× the realistic 4-week gain.
 *
 *  Edge case: when currentE1rm sits exactly at (gridPoint − 1) — e.g.
 *  current=114 with grid={112.5, 115, 117.5} — the lower bound resolves to
 *  current + 1 rather than current + one full grid step. The validator
 *  therefore admits a target of current + 1 kg in that narrow case, which
 *  on heavy lifts (deadlift, coefficient 1.5 kg/wk) is just-below the
 *  "hit by week 1" threshold. Accepted as low-frequency since real e1RM
 *  values rarely land exactly on (grid − 1); the audit fixtures in
 *  scripts/audit-prescription-rules.mjs assume off-grid current values. */
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

export type TargetRecommendation = {
  /** Athlete's current best e1RM for the lift across the 90-day window.
   *  Null when no logged data exists (bootstrap path for first-ever block). */
  current_e1rm: number | null;
  /** OLS slope of per-week max e1RM, kg/wk. Null when <3 weeks of data
   *  OR when slope is non-positive (declining lift — fall through to math). */
  slope_kg_per_wk: number | null;
  /** current + slope × 4, grid-rounded. Null when slope is null. */
  trend_target: number | null;
  /** current + coefficient × 4, grid-rounded. Null when current is null. */
  math_target: number | null;
  /** Which source produced `recommended_target`. 'neither' = no data, no
   *  recommendation; validator falls through and accepts any input. */
  used: "trend" | "math" | "neither";
  recommended_target: number | null;
  /** [min, max] inclusive bounds for the validator. Null when current is null. */
  sanity_bounds: [number, number] | null;
};

export async function computeTargetRecommendation(opts: {
  supabase: SupabaseClient;
  userId: string;
  lift: PrimaryLift;
  todayIso: string;
  phase?: AthletePhase;
}): Promise<TargetRecommendation> {
  const { supabase, userId, lift, todayIso, phase = "cut" } = opts;

  const cutoff = subtractDaysIso(todayIso, 90);
  const namePatterns = PRIMARY_LIFT_NAME_PATTERNS[lift] ?? [];
  if (namePatterns.length === 0) {
    return emptyRecommendation();
  }

  const { data, error } = await supabase
    .from("workouts")
    .select("date, exercises(name, exercise_sets(kg, reps, warmup))")
    .eq("user_id", userId)
    .gte("date", cutoff)
    .order("date", { ascending: true });
  if (error || !data) return emptyRecommendation();

  type RawSet = { kg: number | null; reps: number | null; warmup: boolean | null };
  type RawEx = { name: string; exercise_sets: RawSet[] | null };
  type RawW = { date: string; exercises: RawEx[] | null };
  const rows = data as unknown as RawW[];

  const namesLower = new Set(namePatterns.map((n) => n.toLowerCase()));

  // Per-week max e1RM samples. Week index is days-since-cutoff / 7, floored.
  const cutoffMs = new Date(cutoff + "T00:00:00Z").getTime();
  const weekMax = new Map<number, number>();
  let allTimeMax: number | null = null;

  for (const w of rows) {
    for (const ex of w.exercises ?? []) {
      if (!namesLower.has(ex.name.toLowerCase())) continue;
      for (const s of ex.exercise_sets ?? []) {
        const e1rm = bestComparisonValue(
          [{ kg: s.kg, reps: s.reps, warmup: s.warmup }],
          "e1rm",
        );
        if (e1rm == null) continue;
        if (allTimeMax == null || e1rm > allTimeMax) allTimeMax = e1rm;
        const dayMs = new Date(w.date + "T00:00:00Z").getTime();
        const weekIdx = Math.floor((dayMs - cutoffMs) / (7 * 24 * 60 * 60 * 1000));
        weekMax.set(weekIdx, Math.max(weekMax.get(weekIdx) ?? 0, e1rm));
      }
    }
  }

  if (allTimeMax == null) return emptyRecommendation();
  const current = allTimeMax;

  // OLS slope across per-week samples
  const samples = Array.from(weekMax.entries())
    .map(([weekIndex, e1rm]) => ({ weekIndex, e1rm }))
    .sort((a, b) => a.weekIndex - b.weekIndex);
  const rawSlope = computeOlsSlope(samples);

  // Negative or zero slope on a focus lift is suspect (declining recently —
  // could be a deload week or just a bad session sequence). Fall through to
  // math so the recommendation isn't "target = current".
  const slope = rawSlope != null && rawSlope > 0 ? rawSlope : null;

  const coef = coefficientFor(lift, phase);
  const trendTarget = slope != null ? gridRoundDown(current + slope * 4) : null;
  const mathTarget = gridRoundDown(current + coef * 4);

  let recommended: number | null;
  let used: TargetRecommendation["used"];
  if (trendTarget != null) {
    recommended = trendTarget;
    used = "trend";
  } else {
    recommended = mathTarget;
    used = "math";
  }

  return {
    current_e1rm: current,
    slope_kg_per_wk: rawSlope, // expose the raw slope (even when non-positive) for narration
    trend_target: trendTarget,
    math_target: mathTarget,
    used,
    recommended_target: recommended,
    sanity_bounds: computeSanityBounds({ currentE1rm: current, coefficient: coef }),
  };
}

function emptyRecommendation(): TargetRecommendation {
  return {
    current_e1rm: null,
    slope_kg_per_wk: null,
    trend_target: null,
    math_target: null,
    used: "neither",
    recommended_target: null,
    sanity_bounds: null,
  };
}

function subtractDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
