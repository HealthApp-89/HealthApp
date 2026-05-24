// lib/coach/proactive/check-hrv-chronic.ts
//
// Fires when 5+ of the last 7 days have HRV ≥7% below the 30d baseline.
// Distinct from the existing `hrv_below_baseline` (single-day −5% via 4w
// avg). This one is the sustained-signal "action" sibling.

import type { ProactiveEvent } from "@/lib/data/types";
import type { RecoveryIntelligencePayload } from "@/lib/coach/recovery-intelligence/types";
import {
  HRV_CHRONIC_PCT, HRV_CHRONIC_MIN_DAYS, HRV_CHRONIC_OF_LAST_DAYS,
} from "@/lib/coach/recovery-intelligence/thresholds";

export function checkHrvChronic(p: RecoveryIntelligencePayload): ProactiveEvent[] {
  const baseline = p.baselines.hrv_mean;
  if (baseline == null || baseline <= 0) return [];

  const last7 = p.daily.slice(-HRV_CHRONIC_OF_LAST_DAYS);
  const depressed = last7.filter(
    (d) => d.hrv != null && (d.hrv - baseline) / baseline <= HRV_CHRONIC_PCT,
  );
  if (depressed.length < HRV_CHRONIC_MIN_DAYS) return [];

  return [{
    trigger_type: "hrv_chronic_depression",
    trigger_key: "hrv_chronic_depression",
    payload: {
      vs_baseline_pct_7d: p.derived.hrv_vs_baseline_pct_7d,
      avg_7d: p.derived.hrv_avg_7d,
      baseline_30d: baseline,
      days_depressed: depressed.length,
    },
  }];
}
