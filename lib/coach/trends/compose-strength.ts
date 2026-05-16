// lib/coach/trends/compose-strength.ts
//
// Per-lift e1RM trend computation. Reads the last 12 weeks of workouts,
// computes weekly e1RM peaks per big-four lift, fits OLS slopes for 4w
// and 12w windows, and detects plateaus (3+ consecutive weeks within
// 1.5% of each other). Skips deload weeks when computing plateau spans
// so an intentional light week doesn't fire a false plateau.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { StrengthTrend, PerLiftSlope } from "@/lib/data/types";
import { BIG_FOUR } from "@/lib/coach/big-four";
import { epley } from "@/lib/coach/derived";
import { mondayOf } from "@/lib/coach/weekly-review/date-utils";
import { linearRegression, type Point } from "./linear-regression";

const PLATEAU_THRESHOLD_PCT = 0.015;
const PLATEAU_MIN_WEEKS = 3;

export async function composeStrength(args: {
  supabase: SupabaseClient;
  userId: string;
  today: string;
}): Promise<StrengthTrend> {
  const { supabase, userId, today } = args;

  const windowStart12w = shiftDays(today, -7 * 12);

  const { data: workouts, error: wErr } = await supabase
    .from("workouts")
    .select("date, type, exercises (name, sets:exercise_sets (kg, reps, warmup))")
    .eq("user_id", userId)
    .gte("date", windowStart12w)
    .lte("date", today);
  if (wErr) throw wErr;

  const weeklyPeaks = new Map<string, Map<string, number>>();
  for (const lift of BIG_FOUR) weeklyPeaks.set(lift, new Map());

  type Row = {
    date: string;
    exercises: Array<{
      name: string;
      sets: Array<{ kg: number | null; reps: number | null; warmup: boolean }>;
    }>;
  };

  for (const row of (workouts as Row[] | null) ?? []) {
    const wk = mondayOf(row.date);
    for (const ex of row.exercises) {
      if (!(BIG_FOUR as readonly string[]).includes(ex.name)) continue;
      let peak = 0;
      for (const s of ex.sets) {
        if (s.warmup) continue;
        const e = epley(s.kg, s.reps);
        if (e != null && e > peak) peak = e;
      }
      if (peak === 0) continue;
      const liftMap = weeklyPeaks.get(ex.name)!;
      const existing = liftMap.get(wk) ?? 0;
      if (peak > existing) liftMap.set(wk, peak);
    }
  }

  const { data: tws } = await supabase
    .from("training_weeks")
    .select("week_start, research_phase")
    .eq("user_id", userId)
    .gte("week_start", windowStart12w)
    .lte("week_start", today);
  const twRows =
    ((tws as { week_start: string; research_phase: string | null }[] | null) ?? []);
  const deloadWeeks = new Set<string>(
    twRows.filter((r) => r.research_phase === "deload").map((r) => r.week_start),
  );

  // Current phase comes from the training_weeks row for this week — research_phase
  // lives on training_weeks (per migration 0008), not training_blocks.
  const currentMonday = mondayOf(today);
  const currentWeek = twRows.find((r) => r.week_start === currentMonday) ?? null;

  const perLift: PerLiftSlope[] = BIG_FOUR.map((lift) =>
    computeLiftSlope(lift, weeklyPeaks.get(lift)!, deloadWeeks, today)
  );

  return {
    schema_version: 1,
    per_lift: perLift,
    block_phase_now: currentWeek?.research_phase === "deload" ? "deload" : null,
    on_pace: null,
  };
}

function computeLiftSlope(
  lift: string,
  weeklyPeaks: Map<string, number>,
  deloadWeeks: Set<string>,
  today: string,
): PerLiftSlope {
  void today;

  const sortedWeeks = [...weeklyPeaks.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]));

  if (sortedWeeks.length === 0) {
    return {
      lift,
      e1rm_kg_now: null,
      slope_pct_per_wk_4w: null,
      slope_pct_per_wk_12w: null,
      r_squared_4w: null,
      r_squared_12w: null,
      plateau_active: false,
      plateau_weeks_flat: 0,
    };
  }

  const e1rmNow = sortedWeeks[sortedWeeks.length - 1][1];

  const fitWindow = (weeks: number) => {
    const recent = sortedWeeks.slice(-weeks);
    if (recent.length < 2) return null;
    const points: Point[] = recent.map(([, e1rm], idx) => ({
      x: idx,
      y: e1rm,
    }));
    const meanY = points.reduce((s, p) => s + p.y, 0) / points.length;
    if (meanY === 0) return null;
    const reg = linearRegression(points);
    if (!reg) return null;
    return {
      slope_pct_per_wk: reg.slope / meanY,
      r_squared: reg.r_squared,
    };
  };

  const fit4w = fitWindow(4);
  const fit12w = fitWindow(12);

  const nonDeload = sortedWeeks.filter(([wk]) => !deloadWeeks.has(wk));
  const tail = nonDeload.slice(-12);
  let plateauWeeks = 0;
  if (tail.length >= PLATEAU_MIN_WEEKS) {
    const last = tail[tail.length - 1][1];
    for (let i = tail.length - 1; i >= 0; i--) {
      const e = tail[i][1];
      if (last > 0 && Math.abs(e - last) / last <= PLATEAU_THRESHOLD_PCT) {
        plateauWeeks++;
      } else {
        break;
      }
    }
  }

  return {
    lift,
    e1rm_kg_now: e1rmNow,
    slope_pct_per_wk_4w: fit4w?.slope_pct_per_wk ?? null,
    slope_pct_per_wk_12w: fit12w?.slope_pct_per_wk ?? null,
    r_squared_4w: fit4w?.r_squared ?? null,
    r_squared_12w: fit12w?.r_squared ?? null,
    plateau_active: plateauWeeks >= PLATEAU_MIN_WEEKS,
    plateau_weeks_flat: plateauWeeks,
  };
}

function shiftDays(d: string, days: number): string {
  const dt = new Date(d + "T12:00:00Z");
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
