// lib/coach/autoregulation.ts
//
// Four fatigue signals computed on demand:
//   1. HRV outside SWC band (±0.5 SD of 7d rolling mean) for 3 of last 4 days
//   2. e1RM drop ≥5% on the active block's primary_lift (last 2 sessions vs
//      4w rolling mean)
//   3. RPE drift +2 at fixed load (degraded in v1; returns null when data sparse)
//   4. Sleep <6h for 3+ nights in last 4
//
// Deload trigger: ≥2 signals fired concurrently. Single-signal triggers
// produce false alarms per Bell et al. 2023 Delphi consensus.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PrimaryLift } from "@/lib/data/types";
import { epley, topSet, type SetRow } from "@/lib/coach/derived";

export type SignalReport<T> = T & { breached: boolean };

export type AutoregSignals = {
  hrv: SignalReport<{
    days_outside_swc: number;
    swc_lower: number | null;
    swc_upper: number | null;
    today: number | null;
    sample_days: number; // how many of last 7 had non-null hrv
  }>;
  e1rm: SignalReport<{
    lift: PrimaryLift | null;
    drop_pct: number | null; // proportional, e.g. -0.06 = -6%
    sessions_compared: number;
  }> | null;
  rpe: SignalReport<{
    lift: PrimaryLift | null;
    drift: number | null;
    sessions_compared: number;
  }> | null;
  sleep: SignalReport<{
    short_nights: number; // count in last 4
    threshold_hours: 6;
  }>;
  count: number;            // 0..4 (signals with breached:true; null signals omitted from count)
  should_deload: boolean;   // count >= 2
  computed_at: string;      // YYYY-MM-DD
};

const SLEEP_SHORT_THRESHOLD_HOURS = 6;
const SLEEP_NIGHTS_TO_CHECK = 4;
const SLEEP_BREACH_NIGHTS = 3;
const HRV_DAYS_OUTSIDE_THRESHOLD = 3; // of last 4
const E1RM_DROP_THRESHOLD = -0.05;     // -5% (proportional)

export async function getAutoregulationSignals(
  supabase: SupabaseClient,
  userId: string,
  asOf: string, // YYYY-MM-DD
  primaryLift: PrimaryLift | null,
): Promise<AutoregSignals> {
  // Pull last 7 days of daily_logs + last 90 days of workouts in parallel
  const asOfDate = new Date(asOf + "T00:00:00Z");
  const wk7Start = new Date(asOfDate); wk7Start.setUTCDate(asOfDate.getUTCDate() - 6);
  const d90Start = new Date(asOfDate); d90Start.setUTCDate(asOfDate.getUTCDate() - 89);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  const [dailyRes, woRes] = await Promise.all([
    supabase
      .from("daily_logs")
      .select("date, hrv, sleep_hours")
      .eq("user_id", userId)
      .gte("date", fmt(wk7Start))
      .lte("date", asOf)
      .order("date", { ascending: true }),
    primaryLift
      ? supabase
          .from("workouts")
          .select("date, exercises(name, exercise_sets(kg, reps, warmup, set_index, duration_seconds, failure))")
          .eq("user_id", userId)
          .gte("date", fmt(d90Start))
          .lte("date", asOf)
          .order("date", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (dailyRes.error) throw dailyRes.error;
  if (woRes.error) throw woRes.error;
  const daily = dailyRes.data ?? [];
  const workouts = woRes.data ?? [];

  // ── HRV signal ─────────────────────────────────────────────────────────
  const hrvVals = daily.map((d) => d.hrv).filter((v): v is number => typeof v === "number");
  const hrvMean = hrvVals.length > 0 ? hrvVals.reduce((a, b) => a + b, 0) / hrvVals.length : null;
  const hrvSd =
    hrvVals.length > 1 && hrvMean !== null
      ? Math.sqrt(hrvVals.map((v) => (v - hrvMean) ** 2).reduce((a, b) => a + b, 0) / (hrvVals.length - 1))
      : null;
  const swcLower = hrvMean !== null && hrvSd !== null ? hrvMean - 0.5 * hrvSd : null;
  const swcUpper = hrvMean !== null && hrvSd !== null ? hrvMean + 0.5 * hrvSd : null;

  // Look at last 4 days
  const last4 = daily.slice(-4);
  let daysOutside = 0;
  for (const d of last4) {
    if (d.hrv == null || swcLower === null || swcUpper === null) continue;
    if (d.hrv < swcLower || d.hrv > swcUpper) daysOutside += 1;
  }
  const hrvBreached = swcLower !== null && daysOutside >= HRV_DAYS_OUTSIDE_THRESHOLD;
  const todayHrv = daily[daily.length - 1]?.hrv ?? null;

  // ── e1RM signal ────────────────────────────────────────────────────────
  // Find sessions that contain the primary lift, take top working set,
  // compute e1RM, compare last 2 sessions' max to rolling 4w mean.
  let e1rmSignal: AutoregSignals["e1rm"] = null;
  if (primaryLift) {
    const liftSeries: { date: string; e1rm: number }[] = [];
    for (const w of workouts) {
      for (const e of w.exercises ?? []) {
        if (matchesPrimaryLift(e.name, primaryLift)) {
          const sets = (e.exercise_sets ?? []) as SetRow[];
          const top = topSet(sets);
          if (top && top.kg && top.reps) {
            liftSeries.push({ date: w.date, e1rm: epley(top.kg, top.reps) as number });
          }
        }
      }
    }
    // workouts sorted desc; liftSeries follows that order
    if (liftSeries.length >= 2) {
      const recent2Max = Math.max(liftSeries[0].e1rm, liftSeries[1].e1rm);
      // 4-week mean: take entries from last 28 days
      const cutoff = new Date(asOfDate); cutoff.setUTCDate(asOfDate.getUTCDate() - 27);
      const w4 = liftSeries.filter((p) => p.date >= fmt(cutoff));
      const w4Mean = w4.length > 0 ? w4.reduce((a, b) => a + b.e1rm, 0) / w4.length : null;
      const dropPct = w4Mean !== null ? (recent2Max - w4Mean) / w4Mean : null;
      e1rmSignal = {
        breached: dropPct !== null && dropPct <= E1RM_DROP_THRESHOLD,
        lift: primaryLift,
        drop_pct: dropPct,
        sessions_compared: w4.length,
      };
    }
  }

  // ── RPE signal ─────────────────────────────────────────────────────────
  // v1 has no numeric RPE column — Strong app exposes failure:true only.
  // Per spec: if <3 sessions in last 14d have RPE annotation, return null.
  // For v1 we always return null (no numeric RPE source yet).
  // Cast to the full union so TypeScript doesn't narrow to `never` below.
  const rpeSignal = null as AutoregSignals["rpe"];

  // ── Sleep signal ───────────────────────────────────────────────────────
  const last4Sleep = daily.slice(-SLEEP_NIGHTS_TO_CHECK);
  const shortNights = last4Sleep.filter(
    (d) => typeof d.sleep_hours === "number" && d.sleep_hours < SLEEP_SHORT_THRESHOLD_HOURS,
  ).length;
  const sleepBreached = shortNights >= SLEEP_BREACH_NIGHTS;

  // ── Compose ────────────────────────────────────────────────────────────
  const count =
    (hrvBreached ? 1 : 0) +
    (e1rmSignal?.breached ? 1 : 0) +
    (rpeSignal?.breached ? 1 : 0) +
    (sleepBreached ? 1 : 0);

  return {
    hrv: {
      breached: hrvBreached,
      days_outside_swc: daysOutside,
      swc_lower: swcLower,
      swc_upper: swcUpper,
      today: todayHrv,
      sample_days: hrvVals.length,
    },
    e1rm: e1rmSignal,
    rpe: rpeSignal,
    sleep: {
      breached: sleepBreached,
      short_nights: shortNights,
      threshold_hours: SLEEP_SHORT_THRESHOLD_HOURS,
    },
    count,
    should_deload: count >= 2,
    computed_at: asOf,
  };
}

/** True if exercise name belongs to the named primary lift family.
 *  Conservative — matches the obvious variants only. */
function matchesPrimaryLift(name: string, lift: PrimaryLift): boolean {
  const n = name.toLowerCase();
  switch (lift) {
    case "squat":    return n.includes("squat");
    case "bench":    return n.includes("bench") && n.includes("press");
    case "deadlift": return n.includes("deadlift");
    case "ohp":      return (n.includes("overhead") || n.includes("ohp")) && n.includes("press");
  }
}
