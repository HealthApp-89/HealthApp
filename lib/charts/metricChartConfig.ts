// lib/charts/metricChartConfig.ts
import type { DailyLogKey } from "@/lib/ui/colors";

/**
 * Per-metric interpolation behavior. Set per spec D4 / D5:
 *   - continuous physiology (HRV, RHR, recovery, sleep, body comp): interpolate
 *   - accumulators (steps, calories, distance, exercise min, strain): never
 *
 * Fail-closed default — unlisted metrics do NOT interpolate. Adding a new
 * metric requires an explicit decision here; we'd rather show a true gap
 * than silently estimate something we shouldn't.
 */
export type InterpolateConfig = {
  /** When false, interpolate is a no-op for this metric. */
  enabled: boolean;
  /** Inclusive upper bound, in calendar days. Gaps strictly larger remain null. */
  maxGapDays: number;
};

export const DEFAULT_INTERPOLATE: InterpolateConfig = {
  enabled: false,
  maxGapDays: 0,
};

/**
 * Keyed loosely by string (DailyLogKey is a TS-only type and we'd rather
 * not import the full union just for the config table). Lookup is via
 * `getInterpolateConfig` which falls back to DEFAULT_INTERPOLATE.
 */
export const METRIC_CHART_CONFIG: Record<string, InterpolateConfig> = {
  // Continuous physiology. Two tiers based on how noisy the underlying signal
  // actually is — the goal is visual continuity (interpolated stretches render
  // as a dashed line of the same color) without making linear interpolation
  // claims we can't defend.
  //
  //  - 7-day cap for raw daily measurements (HRV, RHR, sleep duration). These
  //    swing day-to-day with sleep, alcohol, stress, training; bridging a
  //    week of WHOOP downtime (lost charger, weekend without the strap) is
  //    fine, longer than that the linear midpoint stops resembling reality.
  //  - 14-day cap for already-smoothed scores (recovery, sleep_score). These
  //    are bounded 0–100 composites with less raw jitter, so a longer bridge
  //    stays plausible.
  hrv:                { enabled: true,  maxGapDays: 7  },
  resting_hr:         { enabled: true,  maxGapDays: 7  },
  sleep_hours:        { enabled: true,  maxGapDays: 7  },
  deep_sleep_hours:   { enabled: true,  maxGapDays: 7  },
  rem_sleep_hours:    { enabled: true,  maxGapDays: 7  },
  recovery:           { enabled: true,  maxGapDays: 14 },
  sleep_score:        { enabled: true,  maxGapDays: 14 },

  // body composition — 14-day max gap (weigh-ins are sparse)
  weight_kg:          { enabled: true,  maxGapDays: 14 },
  body_fat_pct:       { enabled: true,  maxGapDays: 14 },
  fat_mass_kg:        { enabled: true,  maxGapDays: 14 },
  fat_free_mass_kg:   { enabled: true,  maxGapDays: 14 },
  muscle_mass_kg:     { enabled: true,  maxGapDays: 14 },

  // explicit opt-out — accumulators where missing != partial day
  steps:              { enabled: false, maxGapDays: 0 },
  calories:           { enabled: false, maxGapDays: 0 },
  active_calories:    { enabled: false, maxGapDays: 0 },
  distance_km:        { enabled: false, maxGapDays: 0 },
  exercise_min:       { enabled: false, maxGapDays: 0 },
  strain:             { enabled: false, maxGapDays: 0 },

  // Notable fail-closed (NOT in the locked D4 set; opt-in by editing this map):
  //   spo2, skin_temp_c, hydration_kg, bone_mass_kg
};

export function getInterpolateConfig(metricKey: DailyLogKey | string | undefined): InterpolateConfig {
  if (!metricKey) return DEFAULT_INTERPOLATE;
  return METRIC_CHART_CONFIG[metricKey] ?? DEFAULT_INTERPOLATE;
}
