// lib/coach/intelligence/body-comp-direction.ts
//
// Body Composition Direction Detector (Layer 2) — correlates weight trend,
// body-fat % trend, lift performance (as a muscle-preservation signal), and
// protein to classify whether the athlete is gaining muscle, losing fat,
// recomping, losing muscle, holding neutral, or unknown.
//
// Disambiguates "weight down = good?" — a common misread that conflates
// muscle loss with fat loss. Nora and Peter use this to give the right call
// instead of treating each metric alone.
//
// Pure function — no Supabase calls, no side effects.
// Deterministic: identical input → identical output (inputs sorted internally).
//
// Trend method: OLS (ordinary least squares) linear regression on (day_index,
// value) pairs, slope × 7 to express per-week rate. Preferred over first/last
// because it is noise-resistant and handles gaps (missing days are excluded
// from the regression, not interpolated). Uses the shared olsSlope() from
// lib/coach/trends/linear-regression.ts (same authoritative implementation
// as nutrition-performance-linker.ts).
//
// Lift trend: replicates interference-checker.ts's exact thresholds and logic
// (progressing >1.01, declining <0.98) using brzycki() from lib/coach/e1rm.ts
// for e1RM consistency across the codebase.

import { z } from "zod";
import { brzycki } from "@/lib/coach/e1rm";
import type { WorkoutSession } from "@/lib/data/workouts";
import { olsSlope } from "@/lib/coach/trends/linear-regression";

// ---------------------------------------------------------------------------
// Input type
// ---------------------------------------------------------------------------

export type BodyCompInput = {
  /** Last 28-56 days of daily_logs. Any order; sorted internally. */
  dailyLogs: {
    date: string;
    weight_kg: number | null;
    body_fat_pct: number | null;
    fat_free_mass_kg: number | null;
    protein_g: number | null;
  }[];
  /** Last 28d of workout sessions for lift trend. Any order; sorted internally. */
  workouts: WorkoutSession[];
  /** Most recent bodyweight (kg) for protein g/kg context. */
  bodyweight_kg: number | null;
};

// ---------------------------------------------------------------------------
// Result type + Zod schema
// ---------------------------------------------------------------------------

export const BodyCompDirectionResultSchema = z.object({
  direction: z.enum([
    "gaining_muscle",
    "losing_fat",
    "recomp",
    "losing_muscle",
    "neutral",
    "unknown",
  ]),
  /** 0-1, scales with weeks of coverage and signal count. */
  confidence: z.number().min(0).max(1),
  /** How many weeks of usable weight/bf data span the window. */
  weeks_of_data: z.number().min(0),
  /** OLS slope of weight_kg × 7 (per week). Null if <2 non-null observations. */
  weight_trend_kg_per_week: z.number().nullable(),
  /** OLS slope of body_fat_pct × 7 (per week). Null if <2 non-null observations. */
  bodyfat_trend_pct_per_week: z.number().nullable(),
  lift_trend: z.enum(["progressing", "flat", "declining", "insufficient_data"]),
  /** Observed factors only — no fabricated drivers. */
  drivers: z.array(z.string()),
  /** One-sentence concrete plain-English summary. */
  narrative: z.string().min(1),
});

export type BodyCompDirectionResult = z.infer<typeof BodyCompDirectionResultSchema>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Weight threshold (kg/wk) for "up" vs "flat" vs "down" */
const WEIGHT_UP_KG_PER_WK = 0.1;
const WEIGHT_DOWN_KG_PER_WK = -0.1;

/** Body-fat threshold (%/wk) for "up" vs "flat" vs "down" */
const BF_UP_PCT_PER_WK = 0.05;
const BF_DOWN_PCT_PER_WK = -0.05;

/** Lift trend thresholds (matches interference-checker.ts exactly) */
const LIFT_PROGRESSING_RATIO = 1.01;
const LIFT_DECLINING_RATIO = 0.98;

/** Main-lift keywords (superset of BIG_FOUR + RDL/OHP aliases) */
const MAIN_LIFT_KEYWORDS = [
  "squat",
  "bench press",
  "deadlift",
  "rdl",
  "ohp",
  "overhead press",
] as const;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isMainLift(exerciseName: string): boolean {
  const lower = exerciseName.toLowerCase();
  return MAIN_LIFT_KEYWORDS.some((kw) => lower.includes(kw));
}

const MS_PER_DAY = 86_400_000;

/**
 * Compute OLS trend (kg or % per week) from a set of (date, value) pairs.
 * Returns null when fewer than 2 non-null observations.
 */
function computeTrend(
  rows: { date: string; value: number | null }[],
): { slopePerWeek: number | null; weeksSpan: number } {
  const filtered = rows.filter((r) => r.value !== null) as {
    date: string;
    value: number;
  }[];

  if (filtered.length < 2) {
    return { slopePerWeek: null, weeksSpan: 0 };
  }

  // Sort oldest-first so x increases with time
  const sorted = [...filtered].sort((a, b) => a.date.localeCompare(b.date));
  const baseMs = new Date(sorted[0].date).getTime();

  const points = sorted.map((r) => ({
    x: (new Date(r.date).getTime() - baseMs) / MS_PER_DAY,
    y: r.value,
  }));

  const slopePerDay = olsSlope(points);
  const slopePerWeek = slopePerDay !== null ? slopePerDay * 7 : null;

  // Span in weeks between earliest and latest observation
  const spanDays = (new Date(sorted[sorted.length - 1].date).getTime() - baseMs) / MS_PER_DAY;
  const weeksSpan = spanDays / 7;

  return { slopePerWeek, weeksSpan };
}

/**
 * Compute lift trend: compare avg best-main-lift e1RM in recent 14d vs prior 14d.
 * Matches interference-checker.ts thresholds (>1.01 = progressing, <0.98 = declining).
 */
function computeLiftTrend(
  workouts: WorkoutSession[],
  anchorDate: string,
): {
  trend: BodyCompDirectionResult["lift_trend"];
  recentAvgE1rm: number | null;
  priorAvgE1rm: number | null;
  bestLiftName: string | null;
} {
  if (workouts.length === 0) {
    return {
      trend: "insufficient_data",
      recentAvgE1rm: null,
      priorAvgE1rm: null,
      bestLiftName: null,
    };
  }

  const anchorMs = new Date(anchorDate).getTime();
  const recentE1rms: number[] = [];
  const priorE1rms: number[] = [];

  for (const session of workouts) {
    const sessionMs = new Date(session.date).getTime();
    const daysAgo = (anchorMs - sessionMs) / MS_PER_DAY;

    if (daysAgo < 0 || daysAgo > 28) continue;

    let sessionBestE1rm: number | null = null;
    for (const exercise of session.exercises) {
      if (!isMainLift(exercise.name)) continue;
      for (const set of exercise.sets) {
        if (set.warmup) continue;
        if (set.kg == null || set.kg <= 0) continue;
        if (set.reps == null || set.reps < 1 || set.reps > 12) continue;
        const e1rm = brzycki(set.kg, set.reps);
        if (e1rm == null) continue;
        if (sessionBestE1rm === null || e1rm > sessionBestE1rm) {
          sessionBestE1rm = e1rm;
        }
      }
    }

    if (sessionBestE1rm === null) continue;

    if (daysAgo < 14) {
      recentE1rms.push(sessionBestE1rm);
    } else {
      priorE1rms.push(sessionBestE1rm);
    }
  }

  const totalDataPoints = recentE1rms.length + priorE1rms.length;
  if (totalDataPoints < 2 || recentE1rms.length === 0 || priorE1rms.length === 0) {
    return {
      trend: "insufficient_data",
      recentAvgE1rm: null,
      priorAvgE1rm: null,
      bestLiftName: null,
    };
  }

  const recentAvg = recentE1rms.reduce((s, v) => s + v, 0) / recentE1rms.length;
  const priorAvg = priorE1rms.reduce((s, v) => s + v, 0) / priorE1rms.length;

  let trend: BodyCompDirectionResult["lift_trend"];
  if (recentAvg > priorAvg * LIFT_PROGRESSING_RATIO) {
    trend = "progressing";
  } else if (recentAvg < priorAvg * LIFT_DECLINING_RATIO) {
    trend = "declining";
  } else {
    trend = "flat";
  }

  // Find best lift name for narrative
  let bestLiftName: string | null = null;
  for (const session of workouts) {
    for (const exercise of session.exercises) {
      if (isMainLift(exercise.name)) {
        bestLiftName = exercise.name;
        break;
      }
    }
    if (bestLiftName) break;
  }

  return { trend, recentAvgE1rm: recentAvg, priorAvgE1rm: priorAvg, bestLiftName };
}

// ---------------------------------------------------------------------------
// Main composer
// ---------------------------------------------------------------------------

/**
 * Detect body composition direction from daily logs and workout history.
 *
 * @param input.dailyLogs    Last 28-56 days — any order; sorted internally.
 * @param input.workouts     Last ~28 days of workout sessions — any order; sorted internally.
 * @param input.bodyweight_kg  Most recent known weight for g/kg cross-check.
 * @returns BodyCompDirectionResult validated against BodyCompDirectionResultSchema.
 */
export function composeBodyCompDirection(
  input: BodyCompInput,
): BodyCompDirectionResult {
  const { dailyLogs, workouts, bodyweight_kg } = input;

  // ── Edge case: empty input ────────────────────────────────────────────────
  if (dailyLogs.length === 0 && workouts.length === 0) {
    const empty: BodyCompDirectionResult = {
      direction: "unknown",
      confidence: 0.3,
      weeks_of_data: 0,
      weight_trend_kg_per_week: null,
      bodyfat_trend_pct_per_week: null,
      lift_trend: "insufficient_data",
      drivers: [],
      narrative: "No body data or training data available to assess composition direction.",
    };
    const parsed = BodyCompDirectionResultSchema.safeParse(empty);
    if (!parsed.success) {
      throw new Error(
        `composeBodyCompDirection: empty-input output failed schema validation — ${JSON.stringify(parsed.error.issues)}`,
      );
    }
    return parsed.data;
  }

  // ── Sort inputs defensively: most-recent-first ───────────────────────────
  const sortedLogs = [...dailyLogs].sort((a, b) => b.date.localeCompare(a.date));
  const sortedWorkouts = [...workouts].sort((a, b) => b.date.localeCompare(a.date));

  // Derive anchor date from most-recent log.
  // The final fallback is unreachable: the early-return guard at the top of
  // this function already handles the case where BOTH inputs are empty. A
  // literal placeholder avoids a raw new Date() call (timezone-audit gate).
  const anchorDate =
    sortedLogs.length > 0
      ? sortedLogs[0].date
      : sortedWorkouts.length > 0
        ? sortedWorkouts[0].date
        : "1970-01-01"; // unreachable — empty-input case returned early above

  // ── Weight trend ──────────────────────────────────────────────────────────
  const weightRows = sortedLogs.map((l) => ({ date: l.date, value: l.weight_kg }));
  const { slopePerWeek: weight_trend_kg_per_week, weeksSpan: weightWeeks } =
    computeTrend(weightRows);

  // ── Body-fat trend ────────────────────────────────────────────────────────
  const bfRows = sortedLogs.map((l) => ({ date: l.date, value: l.body_fat_pct }));
  const { slopePerWeek: bodyfat_trend_pct_per_week, weeksSpan: bfWeeks } =
    computeTrend(bfRows);

  // ── Fat-free mass trend (supplementary signal for losing_muscle) ──────────
  const ffmRows = sortedLogs.map((l) => ({ date: l.date, value: l.fat_free_mass_kg }));
  const { slopePerWeek: ffmSlopePerWeek } = computeTrend(ffmRows);
  const ffmClearlyDown =
    ffmSlopePerWeek !== null && ffmSlopePerWeek < -0.1; // FFM falling >0.1 kg/wk

  // ── Weeks of data: use metric with best coverage ─────────────────────────
  const weeks_of_data = Math.max(weightWeeks, bfWeeks);

  // ── Lift trend ────────────────────────────────────────────────────────────
  const { trend: lift_trend, recentAvgE1rm, priorAvgE1rm, bestLiftName } =
    computeLiftTrend(sortedWorkouts, anchorDate);

  // ── Protein context ───────────────────────────────────────────────────────
  const proteinDays = sortedLogs.filter((l) => l.protein_g !== null);
  const avgProtein =
    proteinDays.length > 0
      ? proteinDays.reduce((s, l) => s + l.protein_g!, 0) / proteinDays.length
      : null;
  const gPerKg =
    bodyweight_kg && bodyweight_kg > 0 && avgProtein !== null
      ? avgProtein / bodyweight_kg
      : null;

  // ── Direction decision ────────────────────────────────────────────────────
  //
  // Thresholds:
  //   weight "down"  if wt < -0.1 kg/wk
  //   weight "up"    if wt > +0.1 kg/wk
  //   weight "flat"  if |wt| ≤ 0.1 kg/wk
  //   bf "down"      if bf < -0.05 %/wk
  //   bf "up"        if bf > +0.05 %/wk
  //   bf "flat"      if |bf| ≤ 0.05 %/wk

  const noBodyData = weight_trend_kg_per_week === null && bodyfat_trend_pct_per_week === null;

  const weightDown =
    weight_trend_kg_per_week !== null && weight_trend_kg_per_week < WEIGHT_DOWN_KG_PER_WK;
  const weightUp =
    weight_trend_kg_per_week !== null && weight_trend_kg_per_week > WEIGHT_UP_KG_PER_WK;
  const weightFlat =
    weight_trend_kg_per_week !== null &&
    Math.abs(weight_trend_kg_per_week) <= Math.abs(WEIGHT_UP_KG_PER_WK);

  const bfDown =
    bodyfat_trend_pct_per_week !== null && bodyfat_trend_pct_per_week < BF_DOWN_PCT_PER_WK;
  const bfUp =
    bodyfat_trend_pct_per_week !== null && bodyfat_trend_pct_per_week > BF_UP_PCT_PER_WK;
  const bfFlat =
    bodyfat_trend_pct_per_week !== null &&
    Math.abs(bodyfat_trend_pct_per_week) <= Math.abs(BF_UP_PCT_PER_WK);

  const liftHolding = lift_trend === "progressing" || lift_trend === "flat";
  const liftDeclining = lift_trend === "declining";

  // Track which losing_muscle path fired, to build an accurate narrative.
  let losingMuscleViaFfm = false;

  let direction: BodyCompDirectionResult["direction"];

  if (noBodyData) {
    direction = "unknown";
  } else if (
    weightDown &&
    bfDown &&
    liftHolding
  ) {
    // Losing weight + bf dropping + keeping strength = fat loss
    direction = "losing_fat";
  } else if (
    weightDown &&
    liftDeclining &&
    (bfFlat || bfUp || bodyfat_trend_pct_per_week === null)
  ) {
    // Weight loss + strength loss + no bf improvement = muscle loss (primary path)
    direction = "losing_muscle";
  } else if (ffmClearlyDown && (bfFlat || bfUp)) {
    // FFM clearly falling with no bf improvement = muscle loss (supplementary path)
    direction = "losing_muscle";
    losingMuscleViaFfm = true;
  } else if (
    weightUp &&
    lift_trend === "progressing" &&
    (bfFlat || bfDown)
  ) {
    // Gaining weight + getting stronger + bf not climbing = muscle gain
    direction = "gaining_muscle";
  } else if (
    weightFlat &&
    bfDown &&
    liftHolding
  ) {
    // Weight flat + bf dropping + lifts holding = recomp
    direction = "recomp";
  } else {
    direction = "neutral";
  }

  // ── Confidence ───────────────────────────────────────────────────────────
  //
  // Scales with weeks_of_data:
  //   <2 weeks  → max 0.4
  //   2-4 weeks → up to 0.7
  //   >4 weeks  → up to 0.9
  // Also scales with how many of 3 signals (weight, bf, lift) are present.
  // If direction = 'unknown' → confidence ≤ 0.3.

  const signalCount =
    (weight_trend_kg_per_week !== null ? 1 : 0) +
    (bodyfat_trend_pct_per_week !== null ? 1 : 0) +
    (lift_trend !== "insufficient_data" ? 1 : 0);

  const signalFraction = signalCount / 3;

  let maxConf: number;
  if (weeks_of_data < 2) {
    maxConf = 0.4;
  } else if (weeks_of_data <= 4) {
    maxConf = 0.7;
  } else {
    maxConf = 0.9;
  }

  let confidence = maxConf * signalFraction;

  if (direction === "unknown") {
    confidence = Math.min(confidence, 0.3);
  }

  // Round to 2 decimal places
  confidence = Math.round(confidence * 100) / 100;

  // ── Drivers ────────────────────────────────────────────────────────────────

  const drivers: string[] = [];

  if (weight_trend_kg_per_week !== null) {
    const wt = Math.round(Math.abs(weight_trend_kg_per_week) * 100) / 100;
    const dir = weight_trend_kg_per_week > 0 ? "up" : "down";
    drivers.push(
      `Weight trending ${dir} ${wt.toFixed(2)} kg/week.`,
    );
  }

  if (bodyfat_trend_pct_per_week !== null) {
    const bf = Math.round(Math.abs(bodyfat_trend_pct_per_week) * 100) / 100;
    const dir = bodyfat_trend_pct_per_week > 0 ? "rising" : "falling";
    drivers.push(
      `Body fat ${dir} ${bf.toFixed(2)}%/week.`,
    );
  }

  if (lift_trend === "progressing" && recentAvgE1rm !== null && priorAvgE1rm !== null) {
    const liftLabel = bestLiftName ?? "main lift";
    const recent = Math.round(recentAvgE1rm * 10) / 10;
    const prior = Math.round(priorAvgE1rm * 10) / 10;
    drivers.push(
      `${liftLabel} e1RM progressing: recent 14d avg ${recent} kg vs prior 14d avg ${prior} kg.`,
    );
  } else if (lift_trend === "flat" && recentAvgE1rm !== null && priorAvgE1rm !== null) {
    const liftLabel = bestLiftName ?? "main lift";
    const recent = Math.round(recentAvgE1rm * 10) / 10;
    drivers.push(
      `${liftLabel} e1RM flat at ~${recent} kg (muscle preserved).`,
    );
  } else if (lift_trend === "declining" && recentAvgE1rm !== null && priorAvgE1rm !== null) {
    const liftLabel = bestLiftName ?? "main lift";
    const recent = Math.round(recentAvgE1rm * 10) / 10;
    const prior = Math.round(priorAvgE1rm * 10) / 10;
    const drop = Math.round((prior - recent) * 10) / 10;
    drivers.push(
      `${liftLabel} e1RM declining: recent 14d avg ${recent} kg vs prior 14d avg ${prior} kg (−${drop} kg).`,
    );
  }

  if (gPerKg !== null) {
    const g = Math.round(gPerKg * 100) / 100;
    drivers.push(
      `Protein avg ${Math.round(avgProtein!)}g (${g.toFixed(1)} g/kg bodyweight).`,
    );
  }

  // ── Narrative ──────────────────────────────────────────────────────────────

  let narrative: string;
  const liftLabel = bestLiftName ?? "main lift";
  const proteinNote =
    gPerKg !== null
      ? ` and protein at ${(Math.round(gPerKg * 100) / 100).toFixed(1)} g/kg`
      : "";

  if (noBodyData) {
    narrative =
      "No body composition data (weight or body fat) available — direction cannot be assessed.";
  } else if (direction === "losing_fat") {
    const wtStr =
      weight_trend_kg_per_week !== null
        ? ` ${Math.abs(Math.round(weight_trend_kg_per_week * 100) / 100).toFixed(2)} kg/wk`
        : "";
    const bfStr =
      bodyfat_trend_pct_per_week !== null
        ? ` with body fat down ${Math.abs(Math.round(bodyfat_trend_pct_per_week * 100) / 100).toFixed(2)}%/wk`
        : "";
    narrative = `Weight down${wtStr}${bfStr} and ${liftLabel} e1RM still ${lift_trend === "progressing" ? "climbing" : "holding"} — you're losing fat while preserving muscle.`;
  } else if (direction === "losing_muscle") {
    const gKgStr =
      gPerKg !== null
        ? ` (protein ${(Math.round(gPerKg * 100) / 100).toFixed(1)} g/kg)`
        : "";
    if (losingMuscleViaFfm) {
      // FFM-supplementary path: cite fat-free mass decline, not lifts or weight direction
      const ffmStr =
        ffmSlopePerWeek !== null
          ? ` (${Math.abs(Math.round(ffmSlopePerWeek * 100) / 100).toFixed(2)} kg/wk)`
          : "";
      narrative = `Fat-free mass trending down${ffmStr}${gKgStr} — likely losing muscle; raise protein and ease the deficit.`;
    } else {
      // Primary path: weight down + lifts declining
      const wtStr =
        weight_trend_kg_per_week !== null
          ? ` ${Math.abs(Math.round(weight_trend_kg_per_week * 100) / 100).toFixed(2)} kg/wk`
          : "";
      narrative = `Weight down${wtStr} with ${liftLabel} e1RM declining${gKgStr} — likely losing muscle; raise protein and ease the deficit.`;
    }
  } else if (direction === "gaining_muscle") {
    const wtStr =
      weight_trend_kg_per_week !== null
        ? ` ${Math.round(weight_trend_kg_per_week * 100) / 100} kg/wk`
        : "";
    const bfStr = bfFlat ? " while bf% stays flat" : bfDown ? " with bf% improving" : "";
    narrative = `Weight up${wtStr}${bfStr} and ${liftLabel} e1RM progressing — you're building muscle.`;
  } else if (direction === "recomp") {
    const bfStr =
      bodyfat_trend_pct_per_week !== null
        ? ` ${Math.abs(Math.round(bodyfat_trend_pct_per_week * 100) / 100).toFixed(2)}%/wk`
        : "";
    narrative = `Weight flat while body fat falls${bfStr} and lifts hold — you're recomping (losing fat while building or preserving muscle).`;
  } else if (direction === "neutral") {
    narrative = `Weight and body fat are within flat-band thresholds${proteinNote} — no clear direction; hold course and reassess in 2-3 weeks.`;
  } else {
    // unknown (direction set but noBodyData caught above)
    narrative = "Insufficient body composition data to determine direction.";
  }

  // ── Build and validate result ─────────────────────────────────────────────

  const result: BodyCompDirectionResult = {
    direction,
    confidence,
    weeks_of_data: Math.round(weeks_of_data * 100) / 100,
    weight_trend_kg_per_week:
      weight_trend_kg_per_week !== null
        ? Math.round(weight_trend_kg_per_week * 10000) / 10000
        : null,
    bodyfat_trend_pct_per_week:
      bodyfat_trend_pct_per_week !== null
        ? Math.round(bodyfat_trend_pct_per_week * 10000) / 10000
        : null,
    lift_trend,
    drivers,
    narrative,
  };

  const parsed = BodyCompDirectionResultSchema.safeParse(result);
  if (!parsed.success) {
    throw new Error(
      `composeBodyCompDirection: output failed schema validation — ${JSON.stringify(parsed.error.issues)}`,
    );
  }

  return parsed.data;
}
