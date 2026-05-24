// lib/coach/recovery-intelligence/types.ts
//
// Typed payload feeding both the Trends pill cards and (later) the
// Plan 2 proactive checks. Adding a field here must update both
// the composer that fills it and any check that reads it.

export type RecoveryDailyPoint = {
  date: string;                   // YYYY-MM-DD
  hrv: number | null;
  resting_hr: number | null;
  recovery: number | null;
  sleep_hours: number | null;
  sleep_score: number | null;
  deep_sleep_hours: number | null;
  rem_sleep_hours: number | null;
  strain: number | null;
  spo2: number | null;
  skin_temp_c: number | null;
  respiratory_rate: number | null;
  sleep_start_at: string | null;  // ISO from migration 0031
  sleep_end_at:   string | null;
};

export type WeeklyAggregate = {
  week_start: string;             // YYYY-MM-DD (Monday)
  hrv_avg:        number | null;
  rhr_avg:        number | null;
  recovery_avg:   number | null;
  strain_avg:     number | null;
  sleep_hours_avg:number | null;
  sleep_score_avg:number | null;
  recovery_low_days:  number;     // count of <34 in week
  recovery_ok_days:   number;     // 34–66
  recovery_high_days: number;     // ≥67
};

export type SleepArchitecturePoint = {
  date: string;
  deep_hours:  number | null;
  rem_hours:   number | null;
  light_hours: number | null;     // derived = total − deep − REM, clamped ≥0
  total_hours: number | null;
};

export type BedtimePoint = {
  date: string;
  bedtime_minutes_after_18: number | null;   // 18:00 = 0 → 06:00 next day = 720
  wake_minutes_after_18:    number | null;
};

export type SorenessSeverity = 'mild' | 'sharp' | null;

export type SubjectivePoint = {
  date: string;
  fatigue: 'none' | 'some' | 'heavy' | null;
  sick: boolean;
  sickness_notes: string | null;
  soreness_areas: string[];        // 0 or more of chest|back|legs|shoulders|arms|core
  soreness_severity: SorenessSeverity;
  mobility_done: boolean;          // derived from `workouts` rows
};

export type RecoveryIntelligencePayload = {
  schema_version: 1;
  window_days_daily: 28;
  window_weeks_long: 12;
  daily: RecoveryDailyPoint[];                  // last 28d, oldest first
  weekly: WeeklyAggregate[];                    // last 12w
  sleep_architecture: SleepArchitecturePoint[]; // last 14d
  bedtime: BedtimePoint[];                      // last 28d
  subjective: SubjectivePoint[];                // last 28d
  baselines: {
    hrv_mean: number | null;
    hrv_sd: number | null;
    resting_hr_mean: number | null;
    skin_temp_baseline_c: number | null;        // computed personal 28d
    respiratory_rate_baseline_bpm: number | null; // computed personal 28d
  };
  derived: {
    hrv_avg_7d: number | null;
    hrv_vs_baseline_pct_7d: number | null;
    rhr_avg_7d: number | null;
    rhr_vs_baseline_bpm_7d: number | null;
    sleep_debt_7d_hours: number | null;
    bedtime_mean_minutes: number | null;
    bedtime_sd_minutes: number | null;
    mobility_current_streak_days: number;
    mobility_completion_pct_28d: number;
    recovery_avg_7d: number | null;
    strain_avg_7d: number | null;
  };
};
