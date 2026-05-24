// lib/coach/recovery-intelligence/thresholds.ts
//
// Constants shared between the Trends pill cards (UI reference bands +
// inline interpretation) AND the Plan 2 proactive triggers. One module so
// "what the card visualizes" and "what the trigger fires on" never drift.

/** HRV — % off personal 30d baseline. */
export const HRV_NOISE_PCT             = -0.03;  // ±3% day-to-day = noise
export const HRV_SIGNAL_PCT            = -0.05;  // ≥5% sustained 3+ days = signal
export const HRV_CHRONIC_PCT           = -0.07;  // ≥7% sustained 5+ days = action
export const HRV_CHRONIC_MIN_DAYS      = 5;
export const HRV_CHRONIC_OF_LAST_DAYS  = 7;

/** RHR — bpm off personal 30d baseline. */
export const RHR_ELEVATED_BPM          = 5;      // +5 bpm sustained = illness/overreach
export const RHR_ELEVATED_MIN_DAYS     = 5;
export const RHR_ELEVATED_OF_LAST_DAYS = 7;

/** Sleep — debt vs 8h target, score thresholds. */
export const SLEEP_TARGET_HOURS        = 8;
export const SLEEP_DEBT_HOURS          = 5;      // 7d debt threshold
export const SLEEP_DEBT_WINDOW_DAYS    = 7;
export const SLEEP_TARGET_BAND         = [7, 9] as const;
export const SLEEP_SCORE_MEANINGFUL    = 70;
export const SLEEP_SCORE_ACTION        = 60;

/** Sleep architecture — deep sleep deficit. */
export const DEEP_SLEEP_DEFICIT_HOURS    = 1.0;
export const DEEP_SLEEP_DEFICIT_PCT      = 0.12;
export const DEEP_SLEEP_WINDOW_DAYS      = 14;

/** Bedtime consistency. */
export const BEDTIME_DRIFT_SD_MINUTES   = 75;
export const BEDTIME_WINDOW_DAYS        = 14;

/** Recovery distribution + streaks. */
export const RECOVERY_LOW_TIER          = 34;
export const RECOVERY_HIGH_TIER         = 67;
export const LOW_RECOVERY_STREAK_DAYS   = 4;

/** Strain × recovery balance — overreach setup. */
export const STRAIN_HIGH_AVG_7D         = 14;
export const RECOVERY_LOW_AVG_7D        = 40;

/** Skin temp — deviation from personal 28d baseline (°C). */
export const SKIN_TEMP_DELTA_C          = 0.4;
export const SKIN_TEMP_SUSTAINED_DAYS   = 3;
export const SKIN_TEMP_BASELINE_DAYS    = 28;

/** Respiratory rate — deviation from personal 28d baseline (bpm). */
export const RR_DELTA_BPM               = 1;
export const RR_SUSTAINED_DAYS          = 3;
export const RR_BASELINE_DAYS           = 28;

/** Subjective signals. */
export const RECURRING_SORENESS_OCCURRENCES = 5;
export const RECURRING_SORENESS_WINDOW_DAYS = 14;
export const SICKNESS_LINGERING_DAYS    = 4;
export const HEAVY_FATIGUE_DAYS         = 3;
export const HEAVY_FATIGUE_WINDOW_DAYS  = 7;

/** Post-strain undersleep coupling. */
export const POST_STRAIN_THRESHOLD      = 15;    // strain ≥15 = "high"
export const POST_STRAIN_SLEEP_FLOOR_H  = 7;     // next-day sleep <7h
export const POST_STRAIN_OCCURRENCES    = 2;     // 2+ times in 14d
export const POST_STRAIN_WINDOW_DAYS    = 14;
