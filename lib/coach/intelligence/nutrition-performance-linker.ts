// lib/coach/intelligence/nutrition-performance-linker.ts
//
// Nutrition-Performance Linker (Layer 2) — correlates protein consistency,
// carb timing, deficit magnitude, and body-weight trend against strength
// output so Nora/Peter can say "your deficit is too aggressive given your
// protein is short and lifts are flat" instead of treating each metric alone.
//
// Pure function — no Supabase calls, no side effects.
// Deterministic: identical input → identical output.
//
// ADHERENCE-BASED DEFICIT — deficit severity is measured against the kcal
// target and realized weight change. TDEE is never computed or referenced.
// (See the 2026-05-27 deficit-alarm reframing.)

import { z } from "zod";
import type { WorkoutSession } from "@/lib/data/workouts";

// ---------------------------------------------------------------------------
// Input type (local mirror — only the fields this composer consumes)
// ---------------------------------------------------------------------------

/** Daily log row shape consumed by this composer. */
export type DailyLogRow = {
  date: string;
  calories_eaten: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  weight_kg: number | null;
};

// ---------------------------------------------------------------------------
// Result type + Zod schema
// ---------------------------------------------------------------------------

export const NutritionPerformanceResultSchema = z.object({
  protein_status: z.enum(["adequate", "marginally_short", "critically_low"]),
  carb_timing_suboptimal: z.boolean(),
  deficit_severity: z.enum([
    "appropriate",
    "aggressive_sustainable",
    "unsustainable",
    "not_in_deficit",
  ]),
  predicted_muscle_loss_risk: z.enum(["low", "moderate", "high"]),
  /** Observed factors only — no fabricated drivers */
  drivers: z.array(z.string()),
  /** One-sentence plain-English summary with concrete numbers */
  narrative: z.string().min(1),
});

export type NutritionPerformanceResult = z.infer<
  typeof NutritionPerformanceResultSchema
>;

// ---------------------------------------------------------------------------
// Input type (single object param)
// ---------------------------------------------------------------------------

export type NutritionPerformanceInput = {
  dailyLogs: DailyLogRow[];
  workouts: WorkoutSession[];
  targets: {
    kcal: number;
    protein_g: number;
    phase: "cut" | "maintain" | "lean_bulk" | "recomp" | "unsure";
  };
  bodyweight_kg: number | null;
};

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/** g/kg floor for general protein adequacy */
const PROTEIN_ADEQUATE_G_PER_KG = 1.6;
/** g/kg below which protein is "marginally short" (lower bound) */
const PROTEIN_MARGINAL_G_PER_KG = 1.4;

/** kcal deficit vs target below which we consider "not in deficit" */
const NOT_IN_DEFICIT_THRESHOLD_KCAL = 100;
/** kcal deficit above which severity becomes aggressive_sustainable */
const AGGRESSIVE_DEFICIT_KCAL = 400;
/** kcal deficit above which severity becomes unsustainable */
const UNSUSTAINABLE_DEFICIT_KCAL = 700;

/** kg/week weight loss above which severity becomes aggressive_sustainable */
const AGGRESSIVE_WEEKLY_LOSS_KG = 0.5;
/** kg/week weight loss above which severity becomes unsustainable */
const UNSUSTAINABLE_WEEKLY_LOSS_KG = 0.7;

/** Minimum training-day and rest-day data points to judge carb timing */
const MIN_DAYS_FOR_CARB_TIMING = 3;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Simple OLS linear regression on {x, y} pairs.
 * Returns slope (dy/dx). Returns null if fewer than 2 points.
 */
function olsSlope(points: { x: number; y: number }[]): number | null {
  const n = points.length;
  if (n < 2) return null;
  const xMean = points.reduce((s, p) => s + p.x, 0) / n;
  const yMean = points.reduce((s, p) => s + p.y, 0) / n;
  const num = points.reduce((s, p) => s + (p.x - xMean) * (p.y - yMean), 0);
  const den = points.reduce((s, p) => s + (p.x - xMean) ** 2, 0);
  if (den === 0) return 0;
  return num / den;
}

/**
 * Compute weekly weight loss (kg/week) from non-null weight observations.
 * Uses OLS slope on (day_index, weight_kg) pairs.
 * A positive return value = weight FALLING (loss); negative = gaining.
 * Returns null when fewer than 2 weight observations.
 *
 * Weight slope method: OLS over all non-null weight observations.
 * Day index is derived from the ISO date string (lexicographic difference
 * from the earliest observed date, in days). Slope unit is kg/day; we
 * multiply by 7 to get kg/week.
 */
function computeWeeklyWeightLoss(logs: DailyLogRow[]): number | null {
  const weightPoints = logs
    .filter((l) => l.weight_kg !== null)
    .map((l) => ({ date: l.date, w: l.weight_kg! }));

  if (weightPoints.length < 2) return null;

  // Sort oldest-first so day index increases with time
  const sorted = [...weightPoints].sort((a, b) => a.date.localeCompare(b.date));
  const baseDate = new Date(sorted[0].date).getTime();
  const MS_PER_DAY = 86_400_000;

  const points = sorted.map((p) => ({
    x: (new Date(p.date).getTime() - baseDate) / MS_PER_DAY,
    y: p.w,
  }));

  const slopePerDay = olsSlope(points);
  if (slopePerDay === null) return null;

  // Return positive = weight falling (loss per week)
  return -slopePerDay * 7;
}

/**
 * Total non-warmup working volume (sum of kg×reps) for a single workout.
 * Exercises with null kg or null reps are skipped.
 */
function sessionWorkingVolume(session: WorkoutSession): number {
  let vol = 0;
  for (const ex of session.exercises) {
    for (const s of ex.sets) {
      if (s.warmup) continue;
      if (s.kg !== null && s.reps !== null) {
        vol += s.kg * s.reps;
      }
    }
  }
  return vol;
}

// ---------------------------------------------------------------------------
// Main composer
// ---------------------------------------------------------------------------

/**
 * Correlate protein consistency, carb timing, deficit magnitude, and
 * body-weight trend against strength output.
 *
 * @param input.dailyLogs    Last 14 days of daily_logs rows — any order; sorted internally.
 * @param input.workouts     Last 14 days of workout sessions (for training-day detection + volume).
 * @param input.targets      Kcal and protein targets plus phase.
 * @param input.bodyweight_kg  Most recent known weight for g/kg cross-check.
 * @returns NutritionPerformanceResult validated against NutritionPerformanceResultSchema.
 */
export function composeNutritionPerformance(
  input: NutritionPerformanceInput,
): NutritionPerformanceResult {
  const { dailyLogs, workouts, targets, bodyweight_kg } = input;

  // ── Edge case: empty logs → safe defaults ───────────────────────────────
  if (dailyLogs.length === 0) {
    const empty: NutritionPerformanceResult = {
      protein_status: "adequate",
      carb_timing_suboptimal: false,
      deficit_severity: "not_in_deficit",
      predicted_muscle_loss_risk: "low",
      drivers: [],
      narrative: "Not enough nutrition data to assess.",
    };
    const parsed = NutritionPerformanceResultSchema.safeParse(empty);
    if (!parsed.success) {
      throw new Error(
        `composeNutritionPerformance: empty-input output failed schema validation — ${JSON.stringify(parsed.error.issues)}`,
      );
    }
    return parsed.data;
  }

  // Sort defensively: most-recent-first, regardless of caller ordering.
  const logs = [...dailyLogs].sort((a, b) => b.date.localeCompare(a.date));

  // Build a Set of workout dates for O(1) training-day lookup
  const trainingDates = new Set(workouts.map((w) => w.date));

  const drivers: string[] = [];

  // ── Protein status ────────────────────────────────────────────────────────

  let protein_status: NutritionPerformanceResult["protein_status"] = "adequate";

  const proteinDays = logs.filter((l) => l.protein_g !== null);
  const invalidProteinTarget = targets.protein_g <= 0;

  if (invalidProteinTarget) {
    drivers.push("Protein target is not set (≤0) — protein status not assessable.");
    protein_status = "adequate"; // can't assess, assume adequate per safe default
  } else if (proteinDays.length === 0) {
    // No protein data available
    protein_status = "adequate";
  } else {
    const avgProtein =
      proteinDays.reduce((s, l) => s + l.protein_g!, 0) / proteinDays.length;

    const pctOfTarget = avgProtein / targets.protein_g;
    const gPerKg =
      bodyweight_kg && bodyweight_kg > 0 ? avgProtein / bodyweight_kg : null;

    // Determine status: critically_low takes priority
    const isCriticallyLowPct = pctOfTarget < 0.75;
    const isCriticallyLowGPerKg =
      gPerKg !== null && gPerKg < PROTEIN_MARGINAL_G_PER_KG;

    const isMarginalPct = pctOfTarget >= 0.75 && pctOfTarget < 0.9;
    const isMarginalGPerKg =
      gPerKg !== null &&
      gPerKg >= PROTEIN_MARGINAL_G_PER_KG &&
      gPerKg < PROTEIN_ADEQUATE_G_PER_KG;

    const isAdequatePct = pctOfTarget >= 0.9;
    const isAdequateGPerKg =
      gPerKg === null || gPerKg >= PROTEIN_ADEQUATE_G_PER_KG;

    if (isCriticallyLowPct || isCriticallyLowGPerKg) {
      protein_status = "critically_low";
      const pctStr = `${Math.round(pctOfTarget * 100)}% of target`;
      const gKgStr =
        gPerKg !== null
          ? `, ${(Math.round(gPerKg * 100) / 100).toFixed(1)} g/kg (floor ${PROTEIN_ADEQUATE_G_PER_KG})`
          : "";
      drivers.push(
        `Protein avg ${Math.round(avgProtein)}g — critically low (${pctStr}${gKgStr}).`,
      );
    } else if (isMarginalPct || isMarginalGPerKg) {
      protein_status = "marginally_short";
      const pctStr = `${Math.round(pctOfTarget * 100)}% of target`;
      const gKgStr =
        gPerKg !== null
          ? `, ${(Math.round(gPerKg * 100) / 100).toFixed(1)} g/kg`
          : "";
      drivers.push(
        `Protein avg ${Math.round(avgProtein)}g — marginally short (${pctStr}${gKgStr}).`,
      );
    } else if (isAdequatePct && isAdequateGPerKg) {
      protein_status = "adequate";
      // No driver needed — adequate is the expected state
    } else {
      // Edge: pct adequate but g/kg marginal (already captured above)
      protein_status = "adequate";
    }
  }

  // ── Carb timing ───────────────────────────────────────────────────────────

  let carb_timing_suboptimal = false;

  const trainingDayCarbs: number[] = [];
  const restDayCarbs: number[] = [];

  for (const log of logs) {
    if (log.carbs_g === null) continue;
    if (trainingDates.has(log.date)) {
      trainingDayCarbs.push(log.carbs_g);
    } else {
      restDayCarbs.push(log.carbs_g);
    }
  }

  if (
    trainingDayCarbs.length >= MIN_DAYS_FOR_CARB_TIMING &&
    restDayCarbs.length >= MIN_DAYS_FOR_CARB_TIMING
  ) {
    const avgTrainingCarbs =
      trainingDayCarbs.reduce((s, c) => s + c, 0) / trainingDayCarbs.length;
    const avgRestCarbs =
      restDayCarbs.reduce((s, c) => s + c, 0) / restDayCarbs.length;

    // Suboptimal = training days do NOT have higher carbs than rest days
    if (avgTrainingCarbs <= avgRestCarbs) {
      carb_timing_suboptimal = true;
      drivers.push(
        `Carb timing suboptimal: avg training-day carbs ${Math.round(avgTrainingCarbs)}g ≤ rest-day avg ${Math.round(avgRestCarbs)}g.`,
      );
    }
  } else {
    // Insufficient data to judge
    const trainingCount = trainingDayCarbs.length;
    const restCount = restDayCarbs.length;
    if (trainingCount < MIN_DAYS_FOR_CARB_TIMING || restCount < MIN_DAYS_FOR_CARB_TIMING) {
      drivers.push(
        `Carb timing: insufficient data (${trainingCount} training days, ${restCount} rest days with carb data — need ≥${MIN_DAYS_FOR_CARB_TIMING} each).`,
      );
    }
  }

  // ── Deficit severity (ADHERENCE-BASED — never TDEE) ───────────────────────

  let deficit_severity: NutritionPerformanceResult["deficit_severity"] =
    "not_in_deficit";

  const calorieDays = logs.filter((l) => l.calories_eaten !== null);
  const avgIntake =
    calorieDays.length > 0
      ? calorieDays.reduce((s, l) => s + l.calories_eaten!, 0) / calorieDays.length
      : null;

  const deficitVsTarget =
    avgIntake !== null ? targets.kcal - avgIntake : null;

  // Weekly weight loss via OLS slope
  const weeklyWeightLoss = computeWeeklyWeightLoss(logs);

  if (deficitVsTarget !== null) {
    // "not_in_deficit" when phase is not cut AND eating within 100 kcal of target
    const notInDeficit =
      targets.phase !== "cut" && deficitVsTarget <= NOT_IN_DEFICIT_THRESHOLD_KCAL;

    if (notInDeficit) {
      deficit_severity = "not_in_deficit";
    } else {
      // Evaluate severity: weight trend takes priority over kcal delta when available
      const isUnsustainableByWeight =
        weeklyWeightLoss !== null && weeklyWeightLoss > UNSUSTAINABLE_WEEKLY_LOSS_KG;
      const isAggressiveByWeight =
        weeklyWeightLoss !== null &&
        weeklyWeightLoss > AGGRESSIVE_WEEKLY_LOSS_KG &&
        weeklyWeightLoss <= UNSUSTAINABLE_WEEKLY_LOSS_KG;

      const isUnsustainableByKcal = deficitVsTarget > UNSUSTAINABLE_DEFICIT_KCAL;
      const isAggressiveByKcal =
        deficitVsTarget > AGGRESSIVE_DEFICIT_KCAL &&
        deficitVsTarget <= UNSUSTAINABLE_DEFICIT_KCAL;

      if (isUnsustainableByWeight || isUnsustainableByKcal) {
        deficit_severity = "unsustainable";
        const weightNote =
          weeklyWeightLoss !== null
            ? ` (${(Math.round(weeklyWeightLoss * 100) / 100).toFixed(2)} kg/week loss)`
            : "";
        const kcalNote = avgIntake !== null ? `, avg intake ${Math.round(avgIntake)} kcal vs ${targets.kcal} kcal target` : "";
        drivers.push(
          `Deficit unsustainable${kcalNote}${weightNote}.`,
        );
      } else if (isAggressiveByWeight || isAggressiveByKcal) {
        deficit_severity = "aggressive_sustainable";
        const kcalNote = avgIntake !== null ? ` (avg ${Math.round(avgIntake)} kcal vs ${targets.kcal} target)` : "";
        const weightNote =
          weeklyWeightLoss !== null
            ? `, ${(Math.round(weeklyWeightLoss * 100) / 100).toFixed(2)} kg/week loss`
            : "";
        drivers.push(
          `Deficit aggressive but sustainable${kcalNote}${weightNote}.`,
        );
      } else {
        // In a deficit but moderate
        deficit_severity = "appropriate";
      }
    }
  }

  // ── Lift volume trend ─────────────────────────────────────────────────────
  // Bucket workouts into week 1 (days 0-6 ago = most recent) and week 2 (days 7-13 ago)
  // Volume is total non-warmup kg×reps per week bucket.

  const today = logs[0].date; // most-recent log date (logs sorted newest-first)
  const todayMs = new Date(today).getTime();
  const MS_PER_DAY = 86_400_000;

  let week1Vol = 0;
  let week2Vol = 0;

  for (const session of workouts) {
    const sessionMs = new Date(session.date).getTime();
    const daysAgo = (todayMs - sessionMs) / MS_PER_DAY;
    const sessionVol = sessionWorkingVolume(session);
    if (daysAgo >= 0 && daysAgo < 7) {
      week1Vol += sessionVol;
    } else if (daysAgo >= 7 && daysAgo < 14) {
      week2Vol += sessionVol;
    }
  }

  // "maintained_or_down" = week 2 (older) volume >= week 1 (newer) volume
  // i.e. NOT progressing (week 1 not higher than week 2)
  const volumeNotProgressing = week2Vol > 0 && week1Vol <= week2Vol * 1.0;
  const volumeDropping = week2Vol > 0 && week1Vol < week2Vol * 0.9; // >10% drop

  if (volumeDropping) {
    drivers.push(
      `Lift volume dropping: week-1 ${Math.round(week1Vol)}kg vol vs week-2 ${Math.round(week2Vol)}kg vol.`,
    );
  } else if (volumeNotProgressing && week1Vol > 0) {
    drivers.push(
      `Lift volume flat: week-1 ${Math.round(week1Vol)}kg vol ≈ week-2 ${Math.round(week2Vol)}kg vol.`,
    );
  }

  // ── Predicted muscle loss risk ────────────────────────────────────────────

  const deficitIsRisky =
    deficit_severity === "aggressive_sustainable" ||
    deficit_severity === "unsustainable";
  const proteinIsRisky =
    protein_status === "marginally_short" ||
    protein_status === "critically_low";

  let predicted_muscle_loss_risk: NutritionPerformanceResult["predicted_muscle_loss_risk"];

  if (deficitIsRisky && proteinIsRisky) {
    predicted_muscle_loss_risk = "high";
    // If volume is also dropping, reinforce the driver (already added above)
    if (volumeDropping) {
      // driver already added above
    }
  } else if (
    (deficitIsRisky && !proteinIsRisky) ||
    (!deficitIsRisky && proteinIsRisky) ||
    deficit_severity === "unsustainable"
  ) {
    predicted_muscle_loss_risk = "moderate";
  } else {
    predicted_muscle_loss_risk = "low";
  }

  // Bump to high if volume clearly dropping in deficit + low protein
  if (
    volumeDropping &&
    predicted_muscle_loss_risk === "moderate" &&
    deficitIsRisky
  ) {
    predicted_muscle_loss_risk = "high";
  }

  // ── Narrative ─────────────────────────────────────────────────────────────

  const avgProteinStr =
    proteinDays.length > 0
      ? `${Math.round(proteinDays.reduce((s, l) => s + l.protein_g!, 0) / proteinDays.length)}g`
      : "unknown";

  const gPerKgStr =
    bodyweight_kg && bodyweight_kg > 0 && proteinDays.length > 0
      ? ` (${(
          Math.round(
            (proteinDays.reduce((s, l) => s + l.protein_g!, 0) /
              proteinDays.length /
              bodyweight_kg) *
              100,
          ) / 100
        ).toFixed(1)} g/kg)`
      : "";

  const deficitStr =
    deficitVsTarget !== null && deficitVsTarget > 0
      ? `${Math.round(deficitVsTarget)} kcal deficit`
      : deficitVsTarget !== null && deficitVsTarget <= 0
        ? "eating at/above target"
        : "deficit unknown";

  const volumeStr =
    week1Vol > 0 || week2Vol > 0
      ? volumeDropping
        ? "and volume falling"
        : volumeNotProgressing
          ? "and volume flat"
          : "and volume progressing"
      : "";

  let narrative: string;

  if (predicted_muscle_loss_risk === "high") {
    narrative = `Protein averaging ${avgProteinStr}${gPerKgStr} while running a ${deficitStr} ${volumeStr} — high muscle-loss risk; raise protein before cutting harder.`;
  } else if (predicted_muscle_loss_risk === "moderate") {
    narrative = `Protein at ${avgProteinStr}${gPerKgStr} with a ${deficitStr} ${volumeStr} — moderate muscle-loss risk; monitor protein intake closely.`;
  } else if (deficit_severity === "not_in_deficit") {
    narrative = `Nutrition on track: protein ${avgProteinStr}${gPerKgStr}, eating near target — muscle retention risk low.`;
  } else {
    narrative = `Protein ${avgProteinStr}${gPerKgStr} with a ${deficitStr} ${volumeStr} — muscle-loss risk low given adequate protein.`;
  }

  // ── Build and validate result ─────────────────────────────────────────────

  const result: NutritionPerformanceResult = {
    protein_status,
    carb_timing_suboptimal,
    deficit_severity,
    predicted_muscle_loss_risk,
    drivers,
    narrative,
  };

  const parsed = NutritionPerformanceResultSchema.safeParse(result);
  if (!parsed.success) {
    throw new Error(
      `composeNutritionPerformance: output failed schema validation — ${JSON.stringify(parsed.error.issues)}`,
    );
  }

  return parsed.data;
}
