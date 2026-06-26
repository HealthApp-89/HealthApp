// lib/coach/interventions/evaluate-outcome.ts
//
// Pure deterministic outcome evaluators for the three intervention kinds.
// No I/O — all data is passed in via typed ctx objects.
//
// Design rules:
//   1. SORT INPUTS INTERNALLY — never trust caller ordering.
//   2. Insufficient data → success: null (never fabricate a verdict).
//   3. Reuse isMeaningfulDeviation from lib/whoop/baselines.ts for baseline checks.
//   4. Reuse brzycki / bestComparisonValue from lib/coach/e1rm.ts for lift progression.

import { isMeaningfulDeviation } from "@/lib/whoop/baselines";
import { bestComparisonValue } from "@/lib/coach/e1rm";
import type { CoachInterventionRow, MetricBaseline } from "@/lib/data/types";
import type { DeloadOutcome, SwapOutcome, NutritionOutcome } from "./types";

// Convenience alias so function signatures are concise.
type InterventionRow = CoachInterventionRow;
export type { InterventionRow };

// ── Window constants ───────────────────────────────────────────────────────────

/** Observation window in days after the intervention trigger. */
export const OUTCOME_WINDOWS = {
  reactive_deload: 10,
  exercise_swap: 14,
  nutrition_change: 14,
} as const;

// ── windowClosed ──────────────────────────────────────────────────────────────

/** Returns true when today >= row.started_on + OUTCOME_WINDOWS[row.kind] days.
 *  The window closes (inclusive) on the last day of the observation period. */
export function windowClosed(row: InterventionRow, todayIso: string): boolean {
  const windowDays = OUTCOME_WINDOWS[row.kind];
  const triggerMs = new Date(row.started_on + "T00:00:00Z").getTime();
  const closeMs = triggerMs + windowDays * 24 * 60 * 60 * 1000;
  const todayMs = new Date(todayIso + "T00:00:00Z").getTime();
  return todayMs >= closeMs;
}

// ── DeloadEvalCtx ─────────────────────────────────────────────────────────────

/** Input context for evaluating a reactive_deload intervention. */
export type DeloadLogEntry = {
  date: string;         // YYYY-MM-DD
  hrv: number | null;
  recovery: number | null;
};

export type DeloadSetEntry = {
  date: string;         // YYYY-MM-DD
  exercise: string;
  kg: number;
  reps: number;
  warmup: boolean;
};

export type DeloadEvalCtx = {
  /** ISO date of the intervention trigger (row.started_on). */
  triggered_at: string;
  /** daily_logs rows within the observation window (inclusive). Order unimportant. */
  daily_logs: DeloadLogEntry[];
  /** Working sets for the primary lift from BEFORE the deload (the baseline). */
  workouts_before: DeloadSetEntry[];
  /** Working sets for the primary lift AFTER the deload (the resumption check). */
  workouts_after: DeloadSetEntry[];
  /** 30-day rolling HRV baseline. Null → no baseline seeded yet. */
  hrv_baseline: MetricBaseline | null;
  /** 30-day rolling recovery baseline. Null → no baseline seeded yet. */
  recovery_baseline: MetricBaseline | null;
};

// ── Inconclusive thresholds ────────────────────────────────────────────────────

/** Minimum number of HRV readings in the window to make a verdict. */
const DELOAD_MIN_HRV_DAYS = 3;

/** Performance regression threshold: >10% drop in best comparison value counts
 *  as a regression. Below this, we call it "resumed". */
const PERF_REGRESSION_THRESHOLD = 0.10;

// ── evaluateDeloadOutcome ─────────────────────────────────────────────────────

export function evaluateDeloadOutcome(row: InterventionRow, ctx: DeloadEvalCtx): DeloadOutcome {
  // Sort logs by date ascending (never trust caller ordering)
  const logs = [...ctx.daily_logs].sort((a, b) => a.date.localeCompare(b.date));

  // HRV data points with non-null values
  const hrvPoints = logs.filter((l) => l.hrv != null);

  // Inconclusive: fewer than 3 HRV data points
  if (hrvPoints.length < DELOAD_MIN_HRV_DAYS) {
    return { success: null, hrv_recovery_days: null, performance_resumed: false };
  }

  // Inconclusive: no usable baseline
  if (!ctx.hrv_baseline || ctx.hrv_baseline.mean == null || ctx.hrv_baseline.sd == null) {
    return { success: null, hrv_recovery_days: null, performance_resumed: false };
  }

  const baseline = ctx.hrv_baseline;
  const triggerMs = new Date(ctx.triggered_at + "T00:00:00Z").getTime();

  // Find first day where HRV is no longer meaningfully below baseline.
  // "Back to baseline" = isMeaningfulDeviation returns false (noise zone) OR hrv >= mean.
  // We check hrv is NOT meaningfully below mean (i.e. within the noise band or above).
  let hrv_recovery_days: number | null = null;
  for (const entry of hrvPoints) {
    if (entry.hrv == null) continue;
    // Is this reading still meaningfully below the mean?
    const belowMean = entry.hrv < (baseline.mean ?? Infinity);
    const meaningfullyBelow = belowMean && isMeaningfulDeviation(entry.hrv, baseline);
    if (!meaningfullyBelow) {
      // HRV has returned to baseline band
      const entryMs = new Date(entry.date + "T00:00:00Z").getTime();
      hrv_recovery_days = Math.round((entryMs - triggerMs) / (24 * 60 * 60 * 1000));
      break;
    }
  }

  const hrv_recovered = hrv_recovery_days != null;

  // Performance resumption: compare best working value before vs after.
  // If no before/after data, we assume performance_resumed (insufficient data = not a failure).
  const performance_resumed = evaluatePerformanceResumed(ctx.workouts_before, ctx.workouts_after);

  if (!hrv_recovered) {
    return { success: false, hrv_recovery_days: null, performance_resumed };
  }

  // Success requires both HRV recovery AND no performance regression
  if (!performance_resumed) {
    return { success: false, hrv_recovery_days, performance_resumed: false };
  }

  return { success: true, hrv_recovery_days, performance_resumed: true };
}

/** Compare best comparison value before vs after using working_weight metric.
 *  Returns true if after >= before × (1 - PERF_REGRESSION_THRESHOLD).
 *  Returns true when either side has no data (insufficient data = not a failure). */
function evaluatePerformanceResumed(
  before: DeloadSetEntry[],
  after: DeloadSetEntry[],
): boolean {
  if (before.length === 0 || after.length === 0) {
    // No data on one side — can't detect regression, assume resumed
    return true;
  }

  const toSets = (entries: DeloadSetEntry[]) =>
    entries.map((e) => ({ kg: e.kg, reps: e.reps, warmup: e.warmup }));

  const bestBefore = bestComparisonValue(toSets(before), "working_weight");
  const bestAfter = bestComparisonValue(toSets(after), "working_weight");

  if (bestBefore == null || bestAfter == null) return true;

  // Regression: after dropped more than 10% vs before
  const dropFraction = (bestBefore - bestAfter) / bestBefore;
  return dropFraction <= PERF_REGRESSION_THRESHOLD;
}

// ── SwapEvalCtx ───────────────────────────────────────────────────────────────

/** Input context for evaluating an exercise_swap intervention. */
export type SorenessCheckin = {
  date: string;         // YYYY-MM-DD
  areas: string[];      // e.g. ["hamstrings", "lower back"]
};

export type SwapSetEntry = {
  date: string;
  exercise: string;
  kg: number;
  reps: number;
  warmup: boolean;
};

export type SwapEvalCtx = {
  triggered_at: string;
  /** Morning-intake soreness checkins in the observation window. */
  soreness_checkins: SorenessCheckin[];
  /** The muscle area associated with the swapped-out exercise (for pain detection). */
  swapped_muscle_area: string;
  /** Sets logged for the replacement exercise on/near the trigger date (baseline). */
  baseline_sets: SwapSetEntry[];
  /** Sets logged for the replacement exercise during the window. */
  post_swap_sets: SwapSetEntry[];
};

// ── evaluateSwapOutcome ───────────────────────────────────────────────────────

export function evaluateSwapOutcome(row: InterventionRow, ctx: SwapEvalCtx): SwapOutcome {
  // Inconclusive: no workouts logged in window AND no soreness data
  const hasPostWorkouts = ctx.post_swap_sets.length > 0;
  const hasSorenessData = ctx.soreness_checkins.length > 0;

  if (!hasPostWorkouts && !hasSorenessData) {
    return { success: null, pain_resolved: false, swap_stuck: false };
  }

  // Inconclusive: no post-swap workouts (can't evaluate progression)
  if (!hasPostWorkouts) {
    return { success: null, pain_resolved: false, swap_stuck: false };
  }

  // ── Swap progression check ─────────────────────────────────────────────────
  // "Progressed" = at least one post-swap set with higher weight or more reps
  // than the best baseline set for the same exercise.
  const toSets = (entries: SwapSetEntry[]) =>
    entries.map((e) => ({ kg: e.kg, reps: e.reps, warmup: e.warmup }));

  const bestBaselineKg = bestComparisonValue(toSets(ctx.baseline_sets), "working_weight");
  const bestPostKg = bestComparisonValue(toSets(ctx.post_swap_sets), "working_weight");

  // Check reps improvement too
  const bestBaselineReps = maxReps(ctx.baseline_sets);
  const bestPostReps = maxReps(ctx.post_swap_sets);

  // "Stuck" = no progression on weight OR reps
  let progressed = false;
  if (bestBaselineKg != null && bestPostKg != null && bestPostKg > bestBaselineKg) {
    progressed = true;
  } else if (bestBaselineReps != null && bestPostReps != null && bestPostReps > bestBaselineReps) {
    progressed = true;
  } else if (bestBaselineKg == null && bestPostKg != null) {
    // No baseline data — any post-swap work counts as progressed
    progressed = true;
  }

  const swap_stuck = !progressed;

  // ── Pain resolution ────────────────────────────────────────────────────────
  // pain_resolved = no checkin after trigger mentions the swapped muscle area
  const area = ctx.swapped_muscle_area.toLowerCase();
  const postCheckins = ctx.soreness_checkins.filter(
    (c) => c.date >= ctx.triggered_at,
  );

  // Inconclusive: replacement was trained but no post-trigger soreness data exists.
  // Absence of checkins is NOT evidence that pain resolved — we cannot confirm resolution
  // without at least one post-trigger checkin. Return inconclusive on this dimension.
  if (postCheckins.length === 0) {
    return { success: null, pain_resolved: false, swap_stuck };
  }

  const painPersists = postCheckins.some((c) =>
    c.areas.some((a) => a.toLowerCase().includes(area) || area.includes(a.toLowerCase())),
  );

  const pain_resolved = !painPersists;

  // Success = pain resolved AND replacement progressed
  if (pain_resolved && progressed) {
    return { success: true, pain_resolved: true, swap_stuck: false };
  }

  return { success: false, pain_resolved, swap_stuck };
}

/** Extract max reps from a set of swap entries (non-warmup only). */
function maxReps(entries: SwapSetEntry[]): number | null {
  let max: number | null = null;
  for (const e of entries) {
    if (e.warmup) continue;
    if (e.reps != null && (max == null || e.reps > max)) max = e.reps;
  }
  return max;
}

// ── NutritionEvalCtx ──────────────────────────────────────────────────────────

/** Sub-kind discriminator for nutrition outcome evaluation. */
export type NutritionSubKind = "protein_increase" | "caloric_adjustment" | "body_comp_improve";

export type NutritionLogEntry = {
  date: string;
  calories_eaten: number | null;
  protein_g: number | null;
  weight_kg: number | null;
};

export type NutritionEvalCtx = {
  triggered_at: string;
  /** Which facet of nutrition this intervention targeted. */
  sub_kind: NutritionSubKind;
  /** daily_logs for the 7d before the trigger (baseline period). */
  baseline_logs: NutritionLogEntry[];
  /** daily_logs for the observation window (triggered_at onward). */
  window_logs: NutritionLogEntry[];
  /** The caloric target to hit (for caloric_adjustment sub-kind). */
  caloric_target?: number;
};

// ── Inconclusive thresholds ────────────────────────────────────────────────────

/** Minimum number of nutrition log days in the window to make a verdict. */
const NUTRITION_MIN_DAYS = 5;

/** Protein improvement threshold in grams (>=5g vs baseline avg). */
const PROTEIN_IMPROVEMENT_MIN_G = 5;

/** Caloric target tolerance band in kcal (avg must be within ±200). */
const CALORIC_TOLERANCE_KCAL = 200;

/** Body composition improvement threshold in kg (>=0.3kg in the right direction). */
const BODY_COMP_MIN_DELTA_KG = 0.3;

// ── evaluateNutritionOutcome ──────────────────────────────────────────────────

export function evaluateNutritionOutcome(
  row: InterventionRow,
  ctx: NutritionEvalCtx,
): NutritionOutcome {
  // Sort inputs internally
  const windowLogs = [...ctx.window_logs].sort((a, b) => a.date.localeCompare(b.date));
  const baselineLogs = [...ctx.baseline_logs].sort((a, b) => a.date.localeCompare(b.date));

  const subKind = ctx.sub_kind;

  // Inconclusive: fewer than 5 days of nutrition data in window
  if (windowLogs.length < NUTRITION_MIN_DAYS) {
    const signal = buildNutritionSignal(subKind, windowLogs, baselineLogs, ctx.caloric_target, row);
    return { success: null, signal, improved: false };
  }

  switch (subKind) {
    case "protein_increase":
      return evaluateProteinIncrease(windowLogs, baselineLogs);
    case "caloric_adjustment":
      return evaluateCaloricAdjustment(windowLogs, ctx.caloric_target ?? null);
    case "body_comp_improve":
      return evaluateBodyCompImprove(windowLogs, baselineLogs, row);
    default:
      // Fallback: inconclusive
      return { success: null, signal: "unknown sub_kind", improved: false };
  }
}

function evaluateProteinIncrease(
  windowLogs: NutritionLogEntry[],
  baselineLogs: NutritionLogEntry[],
): NutritionOutcome {
  const windowProtein = windowLogs
    .map((l) => l.protein_g)
    .filter((v): v is number => v != null);
  const baselineProtein = baselineLogs
    .map((l) => l.protein_g)
    .filter((v): v is number => v != null);

  const windowAvg = avg(windowProtein);
  const baselineAvg = baselineProtein.length > 0 ? avg(baselineProtein) : null;

  const delta = baselineAvg != null && windowAvg != null ? windowAvg - baselineAvg : null;
  const improved = delta != null && delta >= PROTEIN_IMPROVEMENT_MIN_G;
  const signal = delta != null
    ? `protein avg: ${windowAvg != null ? Math.round(windowAvg) : "?"} g/d (${delta >= 0 ? "+" : ""}${Math.round(delta)} g vs baseline)`
    : `protein avg: ${windowAvg != null ? Math.round(windowAvg) : "?"} g/d (no baseline)`;

  return { success: improved, signal, improved };
}

function evaluateCaloricAdjustment(
  windowLogs: NutritionLogEntry[],
  caloricTarget: number | null,
): NutritionOutcome {
  const windowCalories = windowLogs
    .map((l) => l.calories_eaten)
    .filter((v): v is number => v != null);

  const windowAvg = avg(windowCalories);

  if (caloricTarget == null || windowAvg == null) {
    const signal = `calorie avg: ${windowAvg != null ? Math.round(windowAvg) : "?"} kcal/d (no target set)`;
    return { success: null, signal, improved: false };
  }

  const delta = Math.abs(windowAvg - caloricTarget);
  const improved = delta <= CALORIC_TOLERANCE_KCAL;
  const signal = `calorie avg: ${Math.round(windowAvg)} kcal/d (target: ${caloricTarget}, Δ ${Math.round(delta)} kcal)`;

  return { success: improved, signal, improved };
}

function evaluateBodyCompImprove(
  windowLogs: NutritionLogEntry[],
  baselineLogs: NutritionLogEntry[],
  row: InterventionRow,
): NutritionOutcome {
  const windowWeights = windowLogs
    .map((l) => l.weight_kg)
    .filter((v): v is number => v != null);

  if (windowWeights.length === 0) {
    return { success: null, signal: "no weight data in window", improved: false };
  }

  // Determine intended direction from row context (from > to = cut, from < to = bulk)
  const fromWeight = typeof row.context.from === "number" ? row.context.from : null;
  const toWeight = typeof row.context.to === "number" ? row.context.to : null;
  const intendedCut = fromWeight != null && toWeight != null && fromWeight > toWeight;
  const intendedBulk = fromWeight != null && toWeight != null && fromWeight < toWeight;

  // Compare baseline avg vs window avg
  const baselineWeights = baselineLogs
    .map((l) => l.weight_kg)
    .filter((v): v is number => v != null);
  const baselineAvg = baselineWeights.length > 0 ? avg(baselineWeights) : null;
  const windowAvg = avg(windowWeights);
  const firstWeight = windowWeights[0];

  const referenceWeight = baselineAvg ?? firstWeight;
  const delta = windowAvg != null ? referenceWeight - windowAvg : null; // positive = lost weight

  let improved = false;
  if (delta != null) {
    if (intendedCut) {
      improved = delta >= BODY_COMP_MIN_DELTA_KG; // lost >=0.3 kg
    } else if (intendedBulk) {
      improved = -delta >= BODY_COMP_MIN_DELTA_KG; // gained >=0.3 kg
    } else {
      // No direction context — measure absolute movement
      improved = Math.abs(delta) >= BODY_COMP_MIN_DELTA_KG;
    }
  }

  const directionText = intendedCut ? "cut" : intendedBulk ? "bulk" : "neutral";
  const signal =
    delta != null && windowAvg != null
      ? `weight avg: ${windowAvg.toFixed(1)} kg (ref: ${referenceWeight.toFixed(1)} kg, Δ ${delta >= 0 ? "-" : "+"}${Math.abs(delta).toFixed(1)} kg, goal: ${directionText})`
      : "insufficient weight data";

  return { success: improved, signal, improved };
}

// ── buildNutritionSignal — used in inconclusive path ──────────────────────────

function buildNutritionSignal(
  subKind: NutritionSubKind,
  windowLogs: NutritionLogEntry[],
  _baselineLogs: NutritionLogEntry[],
  caloricTarget: number | undefined,
  _row: InterventionRow,
): string {
  if (subKind === "protein_increase") {
    const windowProtein = windowLogs.map((l) => l.protein_g).filter((v): v is number => v != null);
    const avg_ = avg(windowProtein);
    return `protein avg (partial, ${windowLogs.length} days): ${avg_ != null ? Math.round(avg_) : "?"} g/d`;
  }
  if (subKind === "caloric_adjustment") {
    const windowCal = windowLogs.map((l) => l.calories_eaten).filter((v): v is number => v != null);
    const avg_ = avg(windowCal);
    return `calorie avg (partial, ${windowLogs.length} days): ${avg_ != null ? Math.round(avg_) : "?"} kcal/d${caloricTarget != null ? ` vs target ${caloricTarget}` : ""}`;
  }
  if (subKind === "body_comp_improve") {
    const windowWeights = windowLogs.map((l) => l.weight_kg).filter((v): v is number => v != null);
    const avg_ = avg(windowWeights);
    return `weight avg (partial, ${windowLogs.length} days): ${avg_ != null ? avg_.toFixed(1) : "?"} kg`;
  }
  return `inconclusive: only ${windowLogs.length} days of data`;
}

// ── Math helpers ──────────────────────────────────────────────────────────────

function avg(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
