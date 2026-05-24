// lib/coach/proactive/check-rhr-elevated.ts
//
// Fires when 5+ of the last 7 days have RHR ≥+5 bpm vs the 30d baseline.
// First clear illness/overreach signal — often precedes symptoms by 24-48h.

import type { ProactiveEvent } from "@/lib/data/types";
import type { RecoveryIntelligencePayload } from "@/lib/coach/recovery-intelligence/types";
import {
  RHR_ELEVATED_BPM, RHR_ELEVATED_MIN_DAYS, RHR_ELEVATED_OF_LAST_DAYS,
} from "@/lib/coach/recovery-intelligence/thresholds";

export function checkRhrElevated(p: RecoveryIntelligencePayload): ProactiveEvent[] {
  const baseline = p.baselines.resting_hr_mean;
  if (baseline == null) return [];

  const last7 = p.daily.slice(-RHR_ELEVATED_OF_LAST_DAYS);
  const elevated = last7.filter(
    (d) => d.resting_hr != null && d.resting_hr - baseline >= RHR_ELEVATED_BPM,
  );
  if (elevated.length < RHR_ELEVATED_MIN_DAYS) return [];

  return [{
    trigger_type: "rhr_elevated",
    trigger_key: "rhr_elevated",
    payload: {
      vs_baseline_bpm_7d: p.derived.rhr_vs_baseline_bpm_7d,
      avg_7d: p.derived.rhr_avg_7d,
      baseline_30d: baseline,
      days_elevated: elevated.length,
    },
  }];
}
