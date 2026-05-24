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

  type Baselines = { hrv_mean?: number; hrv_sd?: number; resting_hr_mean?: number };
  const b = (profileRes.data?.whoop_baselines as Baselines | null) ?? {};
  const hrv_mean = b.hrv_mean ?? null;
  const hrv_sd = b.hrv_sd ?? null;
  const rhr_mean = b.resting_hr_mean ?? null;

  // Personal 28d baselines for skin temp + respiratory rate.
  const skin_temp_baseline_c =
    avg(daily.map((d) => d.skin_temp_c));
  const respiratory_rate_baseline_bpm =
    avg(daily.map((d) => d.respiratory_rate));

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
      skin_temp_baseline_c,
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
