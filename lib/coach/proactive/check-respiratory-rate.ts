// lib/coach/proactive/check-respiratory-rate.ts
//
// Fires when RR is >+1 bpm above personal 28d baseline for 3+ days.
// Often the earliest infection signal (precedes skin temp).

import type { ProactiveEvent } from "@/lib/data/types";
import type { RecoveryIntelligencePayload } from "@/lib/coach/recovery-intelligence/types";
import {
  RR_DELTA_BPM, RR_SUSTAINED_DAYS,
} from "@/lib/coach/recovery-intelligence/thresholds";

export function checkRespiratoryRate(p: RecoveryIntelligencePayload): ProactiveEvent[] {
  const baseline = p.baselines.respiratory_rate_baseline_bpm;
  if (baseline == null) return [];

  let streak = 0;
  let sum = 0;
  for (let i = p.daily.length - 1; i >= 0; i--) {
    const r = p.daily[i].respiratory_rate;
    if (r == null) break;
    if (r - baseline < RR_DELTA_BPM) break;
    streak++;
    sum += r - baseline;
  }
  if (streak < RR_SUSTAINED_DAYS) return [];

  return [{
    trigger_type: "respiratory_rate_elevated",
    trigger_key: "respiratory_rate_elevated",
    payload: {
      delta_bpm_avg: sum / streak,
      days_elevated: streak,
      baseline_28d: baseline,
    },
  }];
}
