// lib/coach/trends/compose-cross.ts
//
// Cross-metric correlations (two pairs):
//   1. nutrition × weight: weekly avg kcal vs weekly weight delta (kg)
//   2. volume × recovery:  weekly working sets vs next-week HRV avg (lag-1)
//
// Each returns 4w and 12w insight cards. R² thresholds:
//   >= 0.6 → strong, show slope confidently
//   >= 0.3 → moderate, hedge in prose
//   <  0.3 → weak, say "no clear relationship"

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CrossInsight, TrendWindow } from "@/lib/data/types";
import { mondayOf } from "@/lib/coach/weekly-review/date-utils";
import { linearRegression } from "./linear-regression";

const N_MIN_4W = 4;
const N_MIN_12W = 8;

export async function composeCross(args: {
  supabase: SupabaseClient;
  userId: string;
  today: string;
}): Promise<CrossInsight[]> {
  const { supabase, userId, today } = args;
  const windowStart12w = shiftDays(today, -7 * 12);

  const { data: logs } = await supabase
    .from("daily_logs")
    .select("date, weight_kg, calories_eaten, hrv")
    .eq("user_id", userId)
    .gte("date", windowStart12w)
    .lte("date", today)
    .order("date", { ascending: true });

  const { data: workouts } = await supabase
    .from("workouts")
    .select("date, exercises (sets:exercise_sets (kg, reps, warmup))")
    .eq("user_id", userId)
    .gte("date", windowStart12w)
    .lte("date", today);

  type Log = { date: string; weight_kg: number | null; calories_eaten: number | null; hrv: number | null };
  type Workout = {
    date: string;
    exercises: Array<{ sets: Array<{ kg: number | null; reps: number | null; warmup: boolean }> }>;
  };

  const weekly = new Map<string, {
    kcalSum: number; kcalDays: number;
    weightStart: number | null; weightEnd: number | null;
    hrvSum: number; hrvDays: number;
    setCount: number;
  }>();
  function getWeek(d: string) {
    const wk = mondayOf(d);
    let cell = weekly.get(wk);
    if (!cell) {
      cell = { kcalSum: 0, kcalDays: 0, weightStart: null, weightEnd: null, hrvSum: 0, hrvDays: 0, setCount: 0 };
      weekly.set(wk, cell);
    }
    return cell;
  }

  for (const l of (logs as Log[] | null) ?? []) {
    const cell = getWeek(l.date);
    if (l.calories_eaten != null) { cell.kcalSum += l.calories_eaten; cell.kcalDays++; }
    if (l.weight_kg != null) {
      if (cell.weightStart == null) cell.weightStart = l.weight_kg;
      cell.weightEnd = l.weight_kg;
    }
    if (l.hrv != null) { cell.hrvSum += l.hrv; cell.hrvDays++; }
  }

  for (const w of (workouts as Workout[] | null) ?? []) {
    const cell = getWeek(w.date);
    for (const ex of w.exercises) {
      for (const s of ex.sets) {
        if (!s.warmup) cell.setCount++;
      }
    }
  }

  const weeks = [...weekly.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  const nutWeight: Array<{ x: number; y: number; week_start: string }> = [];
  for (const [wk, cell] of weeks) {
    if (cell.kcalDays === 0 || cell.weightStart == null || cell.weightEnd == null) continue;
    nutWeight.push({
      x: cell.kcalSum / cell.kcalDays,
      y: cell.weightEnd - cell.weightStart,
      week_start: wk,
    });
  }

  const volRec: Array<{ x: number; y: number; week_start: string }> = [];
  for (let i = 0; i < weeks.length - 1; i++) {
    const [wk, cell] = weeks[i];
    const nextCell = weeks[i + 1][1];
    if (cell.setCount === 0 || nextCell.hrvDays === 0) continue;
    volRec.push({
      x: cell.setCount,
      y: nextCell.hrvSum / nextCell.hrvDays,
      week_start: wk,
    });
  }

  const insights: CrossInsight[] = [];

  function buildPair(
    pair: CrossInsight["pair"],
    points: Array<{ x: number; y: number; week_start: string }>,
    window: TrendWindow,
  ): CrossInsight | null {
    const nMin = window === "4w" ? N_MIN_4W : N_MIN_12W;
    const slice = window === "4w" ? points.slice(-4) : points.slice(-12);
    if (slice.length < nMin) return null;

    const reg = linearRegression(slice);
    if (!reg) return null;

    const insight_md = pair === "nutrition_x_weight"
      ? nutritionXWeightInsight(reg, window)
      : volumeXRecoveryInsight(reg, window);

    return {
      schema_version: 1,
      pair,
      window,
      slope: reg.slope,
      intercept: reg.intercept,
      r_squared: reg.r_squared,
      n_points: reg.n,
      insight_md,
      points: slice,
    };
  }

  for (const window of ["4w", "12w"] as const) {
    const nw = buildPair("nutrition_x_weight", nutWeight, window);
    if (nw) insights.push(nw);
    const vr = buildPair("volume_x_recovery", volRec, window);
    if (vr) insights.push(vr);
  }

  return insights;
}

function nutritionXWeightInsight(
  reg: { slope: number; intercept: number; r_squared: number; n: number },
  window: TrendWindow,
): string {
  const wTxt = window === "4w" ? "last 4 weeks" : "last 12 weeks";
  if (reg.r_squared < 0.3) {
    return `Nutrition and weight show no clear relationship in the ${wTxt} (R² ${reg.r_squared.toFixed(2)}). Weekly variance dominates the signal — likely fluid + glycogen rather than fat.`;
  }
  const per200 = Math.round(200 * reg.slope * 10) / 10;
  const direction = reg.slope > 0 ? "gain" : "lose";
  const dirAdj = reg.slope > 0 ? "higher" : "lower";
  const hedge = reg.r_squared < 0.6 ? " (moderate signal — week-to-week noise still large)" : "";
  return `When kcal averages ${dirAdj}, you ${direction} weight. Each +200 kcal/day correlates with ${per200 >= 0 ? "+" : ""}${per200} kg/wk over the ${wTxt} (R² ${reg.r_squared.toFixed(2)})${hedge}.`;
}

function volumeXRecoveryInsight(
  reg: { slope: number; intercept: number; r_squared: number; n: number },
  window: TrendWindow,
): string {
  const wTxt = window === "4w" ? "last 4 weeks" : "last 12 weeks";
  if (reg.r_squared < 0.3) {
    return `Weekly working-set volume isn't strongly correlated with recovery in the ${wTxt} (R² ${reg.r_squared.toFixed(2)}). HRV is likely driven by non-training factors.`;
  }
  const per10sets = Math.round(10 * reg.slope * 10) / 10;
  const direction = reg.slope < 0 ? "lower" : "higher";
  const hedge = reg.r_squared < 0.6 ? " (moderate signal)" : "";
  return `Higher weekly volume tracks with ${direction} next-week HRV. Each +10 working sets correlates with ${per10sets >= 0 ? "+" : ""}${per10sets} HRV points over the ${wTxt} (R² ${reg.r_squared.toFixed(2)})${hedge}.`;
}

function shiftDays(d: string, days: number): string {
  const dt = new Date(d + "T12:00:00Z");
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
