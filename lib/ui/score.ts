import type { DailyLog } from "@/lib/data/types";

/**
 * @deprecated Use `calcReadinessScore` for the dashboard headline number.
 * Kept for any straggler callers; remove once verified unused.
 */
export function calcScore(log: Pick<DailyLog, "hrv" | "resting_hr" | "sleep_score" | "sleep_hours"> | null | undefined): number | null {
  if (!log) return null;
  const arr: number[] = [];
  if (log.hrv) arr.push(Math.min((log.hrv / 80) * 100, 100));
  if (log.resting_hr) arr.push(Math.max(100 - (log.resting_hr - 40) * 2, 0));
  const slp = log.sleep_score ?? (log.sleep_hours ? (log.sleep_hours / 9) * 100 : null);
  if (slp) arr.push(slp);
  if (!arr.length) return null;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}

/** Anchor list as `[value, score]` pairs, ordered by `value` ascending or
 *  descending. `scoreFromAnchors` interpolates linearly between adjacent
 *  pairs and clamps outside the endpoints. */
type Anchors = ReadonlyArray<readonly [number, number]>;

function scoreFromAnchors(value: number, anchors: Anchors): number {
  const ascending = anchors[0][0] < anchors[anchors.length - 1][0];
  const lo = ascending ? anchors[0] : anchors[anchors.length - 1];
  const hi = ascending ? anchors[anchors.length - 1] : anchors[0];
  if (value <= lo[0]) return lo[1];
  if (value >= hi[0]) return hi[1];
  const ordered = ascending ? anchors : [...anchors].reverse();
  for (let i = 0; i < ordered.length - 1; i++) {
    const [x0, y0] = ordered[i];
    const [x1, y1] = ordered[i + 1];
    if (value >= x0 && value <= x1) {
      const t = (value - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
  }
  return lo[1];
}

const A_SLEEP_SCORE: Anchors = [[30, 0], [45, 25], [60, 50], [75, 75], [90, 100]];
const A_DEEP_SLEEP: Anchors = [[0.4, 0], [0.8, 25], [1.2, 50], [1.6, 75], [2.0, 100]];
const A_HRV_RATIO: Anchors = [[0.6, 0], [0.75, 25], [0.9, 50], [1.05, 75], [1.2, 100]];
// RHR is descending — lower is better.
const A_RHR: Anchors = [[45, 100], [52, 75], [60, 50], [70, 25], [80, 0]];
const A_CHECKIN: Anchors = [[1, 0], [3, 25], [5, 50], [7, 75], [9, 100]];
const A_PROTEIN_RATIO: Anchors = [[0.4, 0], [0.55, 25], [0.7, 50], [0.85, 75], [1.0, 100]];
const A_CARBS_G: Anchors = [[20, 0], [60, 25], [100, 50], [140, 75], [180, 100]];
const A_STEPS: Anchors = [[1500, 0], [3000, 25], [5000, 50], [6500, 75], [8000, 100]];
// Calories are V-shaped around the target — both deficit and surplus penalized.
const A_CALORIES_DELTA: Anchors = [[0, 100], [0.05, 100], [0.1, 75], [0.2, 50], [0.3, 25], [0.4, 0]];

// Recovery-dominant readiness weights (spec 2026-07-01). Recovery bucket ~64%,
// feel ~25%, lifestyle ~11% when all present. Weights re-normalize over whichever
// signals are present, so unlogged lifestyle never penalizes readiness.
const W_HRV = 3;
const W_RHR = 3;
const W_SLEEP = 2;
const W_DEEP = 1;
const W_FEEL = 3.5;
const W_PROTEIN = 0.5;
const W_CALORIES = 0.5;
const W_CARBS = 0.25;
const W_STEPS = 0.25;
const MIN_WEIGHT_FOR_SCORE = 3;

export type ReadinessInputs = {
  log:
    | Pick<
        DailyLog,
        | "hrv"
        | "resting_hr"
        | "sleep_score"
        | "deep_sleep_hours"
        | "protein_g"
        | "calories_eaten"
        | "carbs_g"
        | "steps"
        | "weight_kg"
      >
    | null;
  checkin: { readiness: number | null } | null;
  hrvBaseline: number;
  /** Most recent known weight (kg). Falls back to `log.weight_kg` if not provided. */
  weightKg: number | null;
  /** Daily kcal target (BMR × activity factor). */
  calorieTarget: number | null;
};

export type ReadinessResult = {
  /** Composite 0-100. Null when no recovery signal is present (recovery-required). */
  score: number | null;
  /** Recovery-bucket-only 0-100 (HRV, RHR, sleep score, deep sleep). Null when no
   *  recovery signal is present. Drives the red-recovery floor. */
  recoverySubScore: number | null;
  /** Raw morning self-report (1-10) passed through untouched, for display. */
  feel: number | null;
  band: "low" | "moderate" | "high";
};

/** Maps a composite score to a band, then applies the red-recovery floor:
 *  a red recovery sub-score caps the band regardless of how good the composite
 *  (or the athlete's feel) is. Feel can lower a day, never rescue a red body. */
function bandFromReadiness(score: number, recoverySubScore: number | null): "low" | "moderate" | "high" {
  let band: "low" | "moderate" | "high" = score >= 67 ? "high" : score >= 45 ? "moderate" : "low";
  if (recoverySubScore !== null) {
    if (recoverySubScore < 25) band = "low";
    else if (recoverySubScore < 40 && band === "high") band = "moderate";
  }
  return band;
}

/** Single source of truth for readiness across the dashboard ring and the morning
 *  brief. Recovery-dominant weighted mean over whichever inputs are present. */
export function deriveReadiness(inputs: ReadinessInputs): ReadinessResult {
  const { log, checkin, hrvBaseline, calorieTarget } = inputs;
  const weightKg = inputs.weightKg ?? log?.weight_kg ?? null;
  const feel = checkin?.readiness ?? null;

  let weighted = 0;
  let totalWeight = 0;
  let recWeighted = 0;
  let recWeight = 0;
  const add = (score: number, weight: number) => {
    weighted += score * weight;
    totalWeight += weight;
  };
  const addRecovery = (score: number, weight: number) => {
    add(score, weight);
    recWeighted += score * weight;
    recWeight += weight;
  };

  if (log) {
    if (log.sleep_score != null) addRecovery(scoreFromAnchors(log.sleep_score, A_SLEEP_SCORE), W_SLEEP);
    if (log.deep_sleep_hours != null) addRecovery(scoreFromAnchors(log.deep_sleep_hours, A_DEEP_SLEEP), W_DEEP);
    if (log.hrv != null && hrvBaseline > 0) {
      addRecovery(scoreFromAnchors(log.hrv / hrvBaseline, A_HRV_RATIO), W_HRV);
    }
    if (log.resting_hr != null) addRecovery(scoreFromAnchors(log.resting_hr, A_RHR), W_RHR);

    if (log.protein_g != null && weightKg != null && weightKg > 0) {
      add(scoreFromAnchors(log.protein_g / (1.6 * weightKg), A_PROTEIN_RATIO), W_PROTEIN);
    }
    if (log.calories_eaten != null && calorieTarget != null && calorieTarget > 0) {
      add(scoreFromAnchors(Math.abs(log.calories_eaten / calorieTarget - 1), A_CALORIES_DELTA), W_CALORIES);
    }
    if (log.carbs_g != null) add(scoreFromAnchors(log.carbs_g, A_CARBS_G), W_CARBS);
    if (log.steps != null) add(scoreFromAnchors(log.steps, A_STEPS), W_STEPS);
  }

  if (feel != null) add(scoreFromAnchors(feel, A_CHECKIN), W_FEEL);

  const recoverySubScore = recWeight > 0 ? Math.round(recWeighted / recWeight) : null;

  // Recovery-required: no recovery signal present → readiness is not meaningful.
  if (recWeight === 0) return { score: null, recoverySubScore: null, feel, band: "moderate" };
  if (totalWeight < MIN_WEIGHT_FOR_SCORE) return { score: null, recoverySubScore, feel, band: "moderate" };

  const score = Math.round(weighted / totalWeight);
  return { score, recoverySubScore, feel, band: bandFromReadiness(score, recoverySubScore) };
}

/** @deprecated Prefer `deriveReadiness`. Returns just the composite score. */
export function calcReadinessScore(inputs: ReadinessInputs): number | null {
  return deriveReadiness(inputs).score;
}

/** Epley one-rep-max estimate. */
export function est1rm(kg: number, reps: number): number {
  if (!kg || !reps) return 0;
  if (reps === 1) return kg;
  return Math.round(kg * (1 + reps / 30));
}

export function avg(arr: (number | null | undefined)[]): number | null {
  const f = arr.filter((x): x is number => typeof x === "number" && !Number.isNaN(x));
  if (!f.length) return null;
  return f.reduce((a, b) => a + b, 0) / f.length;
}

/** Display a number with at most `maxDecimals` (default 2), trimming trailing zeros.
 *  25.343897 → "25.34", 78 → "78", 7.50 → "7.5". Returns "—" for null/non-finite. */
export function fmtNum(v: number | null | undefined, maxDecimals = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return Number((v as number).toFixed(maxDecimals)).toString();
}

/** Build a 7-day window aligned to "today", filling gaps with null and labelling Today / weekday. */
export function buildWeekWindow<T extends { date: string }>(rows: T[], today: string): {
  dates: string[];
  rows: (T | null)[];
  labels: string[];
} {
  const dates: string[] = [];
  const todayDt = new Date(today + "T00:00:00Z");
  for (let i = 6; i >= 0; i--) {
    const d = new Date(todayDt);
    d.setUTCDate(d.getUTCDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const aligned = dates.map((d) => byDate.get(d) ?? null);
  const labels = dates.map((d, i) => {
    if (i === dates.length - 1) return "Today";
    const dt = new Date(d + "T00:00:00Z");
    return dt.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }).slice(0, 3);
  });
  return { dates, rows: aligned, labels };
}
