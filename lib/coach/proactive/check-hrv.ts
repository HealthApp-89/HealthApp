// lib/coach/proactive/check-hrv.ts
//
// Emits zero or one event when HRV 4w avg is >5% below the user's 30-day
// baseline. Threshold matches pickHeadline in lib/coach/trends/index.ts.

import type { CoachTrendsPayload, ProactiveEvent } from "@/lib/data/types";

const HRV_BELOW_BASELINE_THRESHOLD = -0.05;

export function checkHrv(
  trends: CoachTrendsPayload,
): ProactiveEvent[] {
  const h = trends.recovery.hrv;
  if (h.vs_baseline_pct_4w == null) return [];
  if (h.vs_baseline_pct_4w >= HRV_BELOW_BASELINE_THRESHOLD) return [];

  return [
    {
      trigger_type: "hrv_below_baseline",
      trigger_key: "hrv_below_baseline",
      payload: {
        vs_baseline_pct_4w: h.vs_baseline_pct_4w,
        avg_4w: h.avg_4w,
        baseline_30d: h.baseline_30d,
      },
    },
  ];
}
