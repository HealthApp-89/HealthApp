// lib/coach/proactive/check-off-pace.ts
//
// Emits zero or one event when the 4w weight rate is outside the target
// band. The flavor field distinguishes "aggressive" (below the lower bound
// — too fast a cut, LBM risk) vs "slow_or_gaining" (above the upper bound
// — insufficient deficit if a cut is intended).
//
// The 4w rate is already a 4-week OLS smoothing from lib/coach/trends/
// compose-body.ts, so single-measurement noise doesn't flip this trigger.

import type { CoachTrendsPayload, ProactiveEvent } from "@/lib/data/types";

export function checkOffPace(
  trends: CoachTrendsPayload,
): ProactiveEvent[] {
  const w = trends.body.weight;
  if (w.in_band !== false) return [];
  if (w.rate_kg_per_wk_4w == null) return [];

  const rate = w.rate_kg_per_wk_4w;
  const flavor: "aggressive" | "slow_or_gaining" =
    rate < w.target_band.lower ? "aggressive" : "slow_or_gaining";

  return [
    {
      trigger_type: "off_pace_weight",
      trigger_key: "off_pace_weight",
      payload: {
        flavor,
        rate_kg_per_wk_4w: rate,
        target_band: w.target_band,
      },
    },
  ];
}
