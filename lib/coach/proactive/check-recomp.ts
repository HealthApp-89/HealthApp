// lib/coach/proactive/check-recomp.ts
//
// Two events from one check, mutually-exclusive shape but not mutually-
// exclusive firing (rare case: LBM up + BF% up = "drift" wins, success
// requires both up-and-down).

import type { CoachTrendsPayload, ProactiveEvent } from "@/lib/data/types";
import {
  RECOMP_SUCCESS_LBM_DELTA_KG,
  RECOMP_SUCCESS_BF_DELTA_PTS,
  RECOMP_DRIFT_WEIGHT_TOL_KG,
  RECOMP_DRIFT_BF_DELTA_PTS,
} from "@/lib/coach/nutrition-intelligence/thresholds";

export function checkRecomp(trends: CoachTrendsPayload): ProactiveEvent[] {
  const events: ProactiveEvent[] = [];
  const lbm4w = trends.body.lbm.delta_4w_kg;
  const bf4w  = trends.body.body_fat_pct.delta_4w_pct;
  const wRate = trends.body.weight.rate_kg_per_wk_4w;

  // Success: LBM up AND BF% down over 4 weeks.
  if (
    lbm4w != null && lbm4w >= RECOMP_SUCCESS_LBM_DELTA_KG &&
    bf4w  != null && bf4w  <= RECOMP_SUCCESS_BF_DELTA_PTS
  ) {
    events.push({
      trigger_type: "recomp_success",
      trigger_key: "recomp_success",
      payload: { lbm_delta_4w_kg: lbm4w, bf_delta_4w_pts: bf4w },
    });
    return events;
  }

  // Drift: scale roughly flat over 4w (rate × 4 within ±0.3kg), BF% up.
  if (
    wRate != null && Math.abs(wRate * 4) <= RECOMP_DRIFT_WEIGHT_TOL_KG &&
    bf4w  != null && bf4w  >= RECOMP_DRIFT_BF_DELTA_PTS
  ) {
    events.push({
      trigger_type: "recomp_drift",
      trigger_key: "recomp_drift",
      payload: {
        weight_rate_kg_per_wk_4w: wRate,
        bf_delta_4w_pts: bf4w,
        weight_change_4w_kg: wRate * 4,
      },
    });
  }
  return events;
}
