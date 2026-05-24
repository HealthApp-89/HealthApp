// lib/coach/proactive/check-skin-temp.ts
//
// Fires when skin temp is >+0.4°C above the personal 28d baseline for
// 3+ consecutive days ending today. Pre-symptomatic illness signal.

import type { ProactiveEvent } from "@/lib/data/types";
import type { RecoveryIntelligencePayload } from "@/lib/coach/recovery-intelligence/types";
import {
  SKIN_TEMP_DELTA_C, SKIN_TEMP_SUSTAINED_DAYS,
} from "@/lib/coach/recovery-intelligence/thresholds";

export function checkSkinTemp(p: RecoveryIntelligencePayload): ProactiveEvent[] {
  const baseline = p.baselines.skin_temp_baseline_c;
  if (baseline == null) return [];

  let streak = 0;
  let sum = 0;
  for (let i = p.daily.length - 1; i >= 0; i--) {
    const t = p.daily[i].skin_temp_c;
    if (t == null) break;
    if (t - baseline < SKIN_TEMP_DELTA_C) break;
    streak++;
    sum += t - baseline;
  }
  if (streak < SKIN_TEMP_SUSTAINED_DAYS) return [];

  return [{
    trigger_type: "skin_temp_elevated",
    trigger_key: "skin_temp_elevated",
    payload: {
      delta_c_avg: sum / streak,
      days_elevated: streak,
      baseline_28d: baseline,
    },
  }];
}
