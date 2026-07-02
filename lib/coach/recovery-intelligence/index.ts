// lib/coach/recovery-intelligence/index.ts
//
// Single entry point: composes all sub-payloads in parallel, computes
// derived/rolling stats, and returns the typed RecoveryIntelligencePayload.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { RecoveryIntelligencePayload, RecoveryDailyPoint, SubjectivePoint } from "./types";
import { composeDaily } from "./compose-daily";
import { composeWeekly } from "./compose-weekly";
import { composeSleepArchitecture } from "./compose-sleep-architecture";
import { composeSleepConsistency } from "./compose-sleep-consistency";
import { composeSubjective } from "./compose-subjective";
import { SLEEP_TARGET_HOURS, SLEEP_DEBT_WINDOW_DAYS } from "./thresholds";
import { readRolling30d } from "@/lib/whoop/baselines";

function avg(xs: Array<number | null | undefined>): number | null {
  const v = xs.filter((x): x is number => x != null);
  if (v.length === 0) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

function mobilityStreak(subjective: SubjectivePoint[]): number {
  let streak = 0;
  for (let i = subjective.length - 1; i >= 0; i--) {
    if (subjective[i].mobility_done) streak++;
    else break;
  }
  return streak;
}

function lastN<T>(arr: T[], n: number): T[] {
  return arr.slice(-n);
}

export async function generateRecoveryIntelligence(args: {
  supabase: SupabaseClient;
  userId: string;
  today: string;
}): Promise<RecoveryIntelligencePayload> {
  const { supabase, userId, today } = args;

  const [daily, weekly, arch, cons, subjective, profileRes] = await Promise.all([
    composeDaily({ supabase, userId, today }),
    composeWeekly({ supabase, userId, today }),
    composeSleepArchitecture({ supabase, userId, today }),
    composeSleepConsistency({ supabase, userId, today }),
    composeSubjective({ supabase, userId, today }),
    supabase.from("profiles").select("whoop_baselines").eq("user_id", userId).maybeSingle(),
  ]);

  // Prefer rolling 30d mean (live anchor, reflects current training modality);
  // fall back to legacy keys and finally to a 28d derivation from the daily
  // series, so HRV/RHR cards stay informative during the first cron run or
  // when WHOOP sync gaps. See lib/whoop/baselines.ts and the 2026-05-30
  // baselines spec.
  type Baselines = {
    hrv_mean?: number; hrv_sd?: number; resting_hr_mean?: number;
    hrv_6mo_avg?: number; rhr_6mo_avg?: number;
  };
  const b = (profileRes.data?.whoop_baselines as Baselines | null) ?? {};
  const r30 = readRolling30d(profileRes.data?.whoop_baselines as Record<string, unknown> | null);
  const hrv28 = avg(daily.map((d) => d.hrv));
  const rhr28 = avg(daily.map((d) => d.resting_hr));
  const hrv_mean = r30?.hrv.mean ?? b.hrv_mean ?? b.hrv_6mo_avg ?? hrv28;
  const rhr_mean = r30?.rhr.mean ?? b.resting_hr_mean ?? b.rhr_6mo_avg ?? rhr28;
  // hrv_sd: prefer the rolling-30d SD (consistent with hrv_mean source);
  // fall back to legacy explicit hrv_sd, then a 28d derivation.
  const hrv_sd = (() => {
    if (r30?.hrv.sd != null) return r30.hrv.sd;
    if (b.hrv_sd != null) return b.hrv_sd;
    const xs = daily.map((d) => d.hrv).filter((v): v is number => v != null);
    if (xs.length < 5 || hrv_mean == null) return null;
    const variance = xs.reduce((acc, x) => acc + (x - hrv_mean) ** 2, 0) / xs.length;
    return Math.sqrt(variance);
  })();

  // Personal 28d baseline for respiratory rate.
  const respiratory_rate_baseline_bpm =
    r30?.resp_rate.mean ?? avg(daily.map((d) => d.respiratory_rate));

  // Derived rolling stats.
  const last7 = lastN(daily, 7);
  const hrv_avg_7d = avg(last7.map((d) => d.hrv));
  const rhr_avg_7d = avg(last7.map((d) => d.resting_hr));
  const recovery_avg_7d = avg(last7.map((d) => d.recovery));
  const strain_avg_7d = avg(last7.map((d) => d.strain));

  const sleep_debt_7d_hours =
    lastN(daily, SLEEP_DEBT_WINDOW_DAYS).reduce<number | null>((acc, d) => {
      if (d.sleep_hours == null) return acc;
      const debt = Math.max(0, SLEEP_TARGET_HOURS - d.sleep_hours);
      return (acc ?? 0) + debt;
    }, null);

  const mobility_28d_done = subjective.filter((s) => s.mobility_done).length;

  return {
    schema_version: 1,
    window_days_daily: 28,
    window_weeks_long: 12,
    daily,
    weekly,
    sleep_architecture: arch,
    bedtime: cons.series,
    subjective,
    baselines: {
      hrv_mean,
      hrv_sd,
      resting_hr_mean: rhr_mean,
      respiratory_rate_baseline_bpm,
    },
    derived: {
      hrv_avg_7d,
      hrv_vs_baseline_pct_7d: hrv_avg_7d != null && hrv_mean != null && hrv_mean > 0
        ? (hrv_avg_7d - hrv_mean) / hrv_mean
        : null,
      rhr_avg_7d,
      rhr_vs_baseline_bpm_7d: rhr_avg_7d != null && rhr_mean != null
        ? rhr_avg_7d - rhr_mean
        : null,
      sleep_debt_7d_hours,
      bedtime_mean_minutes: cons.bedtime_mean_minutes,
      bedtime_sd_minutes: cons.bedtime_sd_minutes,
      mobility_current_streak_days: mobilityStreak(subjective),
      mobility_completion_pct_28d: mobility_28d_done / 28,
      recovery_avg_7d,
      strain_avg_7d,
    },
  };
}
