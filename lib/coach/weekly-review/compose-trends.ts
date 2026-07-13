// lib/coach/weekly-review/compose-trends.ts
//
// §4 of the weekly review. 4-week rolling signals: loss rate, strength
// slope (e1RM linear regression on big-four), /LBM slope, plateau flags.
// Pure-ish: takes a supabase client only for fetching the 4-week window.
//
// Schema note: workouts are normalized via `workouts → exercises →
// exercise_sets` (no jsonb `sets` column). We embed the joins the same
// way lib/query/fetchers/muscleVolume.ts does.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { WeeklyReviewPayload } from "@/lib/data/types";
import { epley } from "@/lib/coach/derived";
import { shiftDays, dayIndex, mondayOf } from "./date-utils";
import { composeStrength } from "@/lib/coach/trends/compose-strength";
import { composeCross } from "@/lib/coach/trends/compose-cross";

type TrendsOutput = WeeklyReviewPayload["trends"];

/** Healthy weight-loss band in kg/wk. Values come from
 *  athletic body-comp literature: above −0.7 kg/wk risks LBM erosion;
 *  below −0.2 kg/wk is slower than visible progress. */
const LOSS_RATE_BAND_KG_PER_WK: [number, number] = [-0.7, -0.2];

const WORKOUT_SELECT =
  "date, exercises (name, sets:exercise_sets (kg, reps, warmup))";

type FlatSet = {
  exercise: string;
  kg: number | null;
  reps: number | null;
  warmup: boolean;
};
type FlatWorkout = { date: string; sets: FlatSet[] };

export async function composeTrends(args: {
  supabase: SupabaseClient;
  userId: string;
  /** Monday of the recap week. The 4-week window ends Sunday of this week. */
  weekStart: string;
}): Promise<TrendsOutput> {
  const { supabase, userId, weekStart } = args;
  const windowStart = shiftDays(weekStart, -28);
  const windowEnd = shiftDays(weekStart, 6);

  const { data: logs, error: lErr } = await supabase
    .from("daily_logs")
    .select("date, weight_kg, fat_free_mass_kg")
    .eq("user_id", userId)
    .gte("date", windowStart)
    .lte("date", windowEnd)
    .order("date", { ascending: true });
  if (lErr) throw lErr;

  const { data: rawWorkouts, error: wErr } = await supabase
    .from("workouts")
    .select(WORKOUT_SELECT)
    .eq("user_id", userId)
    .gte("date", windowStart)
    .lte("date", windowEnd);
  if (wErr) throw wErr;

  const workouts = flattenWorkouts(rawWorkouts ?? []);

  type LogRow = {
    date: string;
    weight_kg: number | null;
    fat_free_mass_kg: number | null;
  };
  const safeLogs: LogRow[] = (logs ?? []) as LogRow[];

  const weights = safeLogs
    .filter((l) => typeof l.weight_kg === "number")
    .map((l) => ({ day: l.date, kg: l.weight_kg as number }));
  const lbm = safeLogs
    .filter((l) => typeof l.fat_free_mass_kg === "number")
    .map((l) => ({ day: l.date, kg: l.fat_free_mass_kg as number }));

  // Weight loss rate: slope of weight (kg) vs day index across the window.
  // computeLinearSlope returns slope per *day*; multiply by 7 to get kg/wk.
  const weightSlopeKgPerDay = computeLinearSlope(
    weights.map((w) => ({ x: dayIndex(w.day, windowStart), y: w.kg })),
  );
  const weightLossKgPerWeek =
    weightSlopeKgPerDay != null ? weightSlopeKgPerDay * 7 : null;
  const lossInBand =
    weightLossKgPerWeek != null
      ? weightLossKgPerWeek >= LOSS_RATE_BAND_KG_PER_WK[0] &&
        weightLossKgPerWeek <= LOSS_RATE_BAND_KG_PER_WK[1]
      : null;

  // Per-lift weekly e1rm peaks → linear regression for strength slope.
  // We pool all (lift, week) points and fit a single slope (kg / day), then
  // normalize to a percent-per-week using the pooled mean as the denominator.
  const liftWeekly = bucketLiftE1rm(workouts);
  const allPoints: Array<{ x: number; y: number }> = [];
  for (const series of liftWeekly.values()) {
    for (const p of series) allPoints.push({ x: p.x, y: p.y });
  }
  const strengthSlopePerDay = computeLinearSlope(allPoints);
  const strengthSlopePctPerWeek =
    strengthSlopePerDay != null && allPoints.length > 0
      ? (strengthSlopePerDay * 7) / mean(allPoints.map((p) => p.y))
      : null;

  const lbmSlopeKgPerDay = computeLinearSlope(
    lbm.map((l) => ({ x: dayIndex(l.day, windowStart), y: l.kg })),
  );
  const lbmSlopePctPerWeek =
    lbmSlopeKgPerDay != null && lbm.length > 0
      ? (lbmSlopeKgPerDay * 7) / mean(lbm.map((l) => l.kg))
      : null;

  const plateauFlags: TrendsOutput["plateau_flags"] = [];
  for (const [lift, series] of liftWeekly.entries()) {
    if (series.length < 3) continue;
    const last3 = series.slice(-3).map((p) => p.y);
    const max3 = Math.max(...last3);
    const min3 = Math.min(...last3);
    if (max3 > 0 && (max3 - min3) / max3 <= 0.015) {
      // The plateau check inspects the last 3 weekly peaks; weeks_flat reports
      // the size of that check window (not the total series length).
      plateauFlags.push({ lift, weeks_flat: 3 });
    }
  }

  const today = shiftDays(weekStart, 6);
  const [strengthTrend, crossInsights] = await Promise.all([
    // Injury fetch is owned by generateCoachTrends (the live orchestrator).
    // Weekly review §4 is a historical recap — pass [] so plateau_spans still
    // surface but without injury gating (the proactive nudge path, not the
    // review, is where gating fires). TODO: wire injuries here if the weekly
    // review §4 narrative ever needs to suppress injury-gated plateaus.
    composeStrength({ supabase, userId, today, injuries: [] }),
    composeCross({ supabase, userId, today }),
  ]);

  const plateauSpans = strengthTrend.per_lift
    .filter((p) => p.plateau_active)
    .map((p) => ({
      lift: p.lift,
      weeks_flat: p.plateau_weeks_flat,
      magnitude_pct: 0,
    }));

  // In-app food-log signals — read committed entries over the Mon-Sun recap
  // window and tally top items by frequency × total kcal. Optional: when the
  // user logged <3 distinct days, omit the section entirely (insufficient
  // signal to call anything a pattern).
  const nutrition = await composeFoodLogTopItems({
    supabase,
    userId,
    weekStart,
    weekEnd: today,
  });

  return {
    window_weeks: 4,
    weight_loss_kg_per_week: weightLossKgPerWeek,
    loss_rate_in_target_band: lossInBand,
    strength_slope_pct_per_week: strengthSlopePctPerWeek,
    lbm_slope_pct_per_week: lbmSlopePctPerWeek,
    plateau_flags: plateauFlags,
    per_lift_slope: strengthTrend.per_lift,
    plateau_spans: plateauSpans,
    cross_insights: crossInsights,
    ...(nutrition ? { nutrition } : {}),
  };
}

/** Tally top items by frequency × total_kcal across committed
 *  food_log_entries in the recap week. Returns null when fewer than 3
 *  distinct days have entries (insufficient signal for the weekly
 *  narrative to reference patterns). Items are keyed case-insensitively;
 *  the rendered name uses the first occurrence's casing. */
async function composeFoodLogTopItems(args: {
  supabase: SupabaseClient;
  userId: string;
  weekStart: string;
  weekEnd: string;
}): Promise<TrendsOutput["nutrition"] | null> {
  const { supabase, userId, weekStart, weekEnd } = args;
  const { data, error } = await supabase
    .from("food_log_entries")
    .select("items, eaten_at")
    .eq("user_id", userId)
    .eq("status", "committed")
    .gte("eaten_at", `${weekStart}T00:00:00Z`)
    .lte("eaten_at", `${weekEnd}T23:59:59Z`);
  if (error) {
    // Degrade gracefully — the rest of trends is still valuable. Caller
    // omits the nutrition field on null.
    console.warn("[compose-trends] food_log_entries fetch failed", error);
    return null;
  }
  const entries = (data ?? []) as Array<{
    items: Array<{ name: string; kcal: number | null }>;
    eaten_at: string;
  }>;
  if (entries.length === 0) return null;

  // eaten_at is UTC; slice(0,10) gives the UTC date (matches the query bounds
  // above which use T00:00:00Z / T23:59:59Z anchoring).
  const dayCount = new Set(entries.map((e) => e.eaten_at.slice(0, 10))).size;
  if (dayCount < 3) return null;

  const tally = new Map<string, { name: string; frequency: number; total_kcal: number }>();
  for (const e of entries) {
    for (const it of e.items ?? []) {
      if (typeof it.name !== "string") continue;
      const key = it.name.toLowerCase();
      const kcal = typeof it.kcal === "number" && Number.isFinite(it.kcal) ? it.kcal : 0;
      const cur = tally.get(key) ?? { name: it.name, frequency: 0, total_kcal: 0 };
      cur.frequency += 1;
      cur.total_kcal += kcal;
      tally.set(key, cur);
    }
  }
  const top_items = [...tally.values()]
    .sort((a, b) => b.frequency * b.total_kcal - a.frequency * a.total_kcal)
    .slice(0, 5);
  if (top_items.length === 0) return null;
  return { top_items };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function flattenWorkouts(
  rows: Array<{ date: string; exercises: unknown }>,
): FlatWorkout[] {
  return rows.map((w) => {
    const exercises =
      (w.exercises as Array<{
        name: string;
        sets: Array<{
          kg: number | null;
          reps: number | null;
          warmup: boolean;
        }>;
      }> | null) ?? [];
    const sets: FlatSet[] = exercises.flatMap((ex) =>
      (ex.sets ?? []).map((s) => ({
        exercise: ex.name,
        kg: s.kg,
        reps: s.reps,
        warmup: s.warmup,
      })),
    );
    return { date: w.date, sets };
  });
}

function computeLinearSlope(
  points: Array<{ x: number; y: number }>,
): number | null {
  const n = points.length;
  if (n < 2) return null;
  const meanX = points.reduce((a, p) => a + p.x, 0) / n;
  const meanY = points.reduce((a, p) => a + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - meanX) * (p.y - meanY);
    den += (p.x - meanX) ** 2;
  }
  if (den === 0) return null;
  return num / den;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Bucket peak e1RM per (exercise, week). Returns one series per exercise
 *  where x = day index from the first observed week, y = peak e1RM that week. */
function bucketLiftE1rm(
  workouts: FlatWorkout[],
): Map<string, Array<{ x: number; y: number }>> {
  const byLift = new Map<string, Map<string, number>>();
  for (const w of workouts) {
    for (const s of w.sets) {
      if (s.warmup) continue;
      const e = epley(s.kg, s.reps);
      if (e == null) continue;
      const wkKey = mondayOf(w.date);
      if (!byLift.has(s.exercise)) byLift.set(s.exercise, new Map());
      const wkMap = byLift.get(s.exercise)!;
      if ((wkMap.get(wkKey) ?? 0) < e) wkMap.set(wkKey, e);
    }
  }
  const result = new Map<string, Array<{ x: number; y: number }>>();
  for (const [lift, wkMap] of byLift.entries()) {
    const baseWk = [...wkMap.keys()].sort()[0];
    const series = [...wkMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([wk, e]) => ({ x: dayIndex(wk, baseWk), y: e }));
    result.set(lift, series);
  }
  return result;
}
