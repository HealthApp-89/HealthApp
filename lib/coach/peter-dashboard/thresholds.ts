// lib/coach/peter-dashboard/thresholds.ts
//
// All numeric severity constants live here. Spec section "Composers"
// is the source of truth; this file is the implementation mirror.

// Recomp
export const RECOMP_LBM_HOLD_KG_4W = -0.2;       // LBM "holding" if delta_4w_kg >= this
export const RECOMP_BF_DOWN_PTS_4W = -0.3;       // BF down ≥ this (negative) is "ok"
export const RECOMP_LIFT_HOLD_SLOPE_PCT_4W = -2.5; // top lifts holding if slope > this
export const RECOMP_LBM_LOSS_WARN_KG_4W = -0.2;
export const RECOMP_LBM_LOSS_URGENT_KG_4W = -0.5;
export const RECOMP_LIFT_DROP_URGENT_PCT_4W = -5;

// Energy
export const ENERGY_UNDER_TARGET_KCAL = 150;     // |delta| ≥ this counts as "under"
export const ENERGY_UNDER_DAYS_WARN = 7;
export const ENERGY_GLP1_DEFICIT_PCT_TDEE_URGENT = 0.25;

// Fatigue
export const FATIGUE_REMI_TRIGGER_COUNT_WARN = 1;
export const FATIGUE_REMI_TRIGGER_COUNT_URGENT = 3;
export const FATIGUE_HRV_BELOW_BASELINE_PCT_WARN = -0.05; // 7d sustained

// Performance
export const PERFORMANCE_PLATEAU_WEEKS_WARN = 3;
export const PERFORMANCE_LIFT_DROP_URGENT_PCT_4W = -5;
export const PERFORMANCE_BIGFOUR_PLATEAU_COUNT_URGENT = 2;

// Plan adherence
export const ADHERENCE_PCT_WARN = 0.70;
export const ADHERENCE_PCT_URGENT = 0.50;
export const ADHERENCE_CONSECUTIVE_WEEKS = 2;

// Goal distance
export const GOAL_PACE_RATIO_OK = 0.90;
export const GOAL_PACE_RATIO_WARN = 0.70;
export const GOAL_ETA_MISS_DAYS_URGENT = 14;

// Cluster: theme severities counted as "active" for cluster eligibility
export const CLUSTER_ACTIVE_SEVERITIES: Array<'warn' | 'urgent'> = ['warn', 'urgent'];
