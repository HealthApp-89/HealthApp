// lib/coach/proactive/check-hrv.ts
//
// Emits zero or one event when HRV 4w avg is meaningfully below the user's
// 30-day baseline. "Meaningfully" today = below the -5% absolute threshold,
// which is already noise-conservative for HRV. The baseline read in
// trends/compose-recovery.ts now sources rolling_30d.hrv.mean (live anchor)
// per the 2026-05-30 baselines spec; before that fix this trigger had
// effectively never fired (vs_baseline_pct_4w was silently null).
//
// If we later thread SD onto CoachTrendsPayload.recovery.hrv, layer the
// Hopkins SWC gate (±0.5 × SD) here on top of the absolute threshold.

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
