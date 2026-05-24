// lib/coach/proactive/check-fried-heavy.ts
//
// Fires when (pan_fried + deep_fried) / classified-method-items ≥ 40%
// over the last 14 days. min-item gate via QUALITY_MIN_CLASSIFIED_ITEMS.

import type { CoachTrendsPayload, ProactiveEvent } from "@/lib/data/types";
import {
  FRIED_HEAVY_SHARE_THRESHOLD,
  QUALITY_MIN_CLASSIFIED_ITEMS,
} from "@/lib/coach/nutrition-intelligence/thresholds";

export function checkFriedHeavy(trends: CoachTrendsPayload): ProactiveEvent[] {
  if (trends.food_quality.total_items < QUALITY_MIN_CLASSIFIED_ITEMS) return [];
  const methods = trends.food_quality.cooking_methods;
  let friedPct = 0;
  for (const m of methods) {
    if (m.method === "pan_fried" || m.method === "deep_fried") friedPct += m.pct;
  }
  if (friedPct < FRIED_HEAVY_SHARE_THRESHOLD) return [];
  return [{
    trigger_type: "fried_heavy",
    trigger_key: "fried_heavy",
    payload: {
      fried_pct: friedPct,
      pan_pct: methods.find((m) => m.method === "pan_fried")?.pct ?? 0,
      deep_pct: methods.find((m) => m.method === "deep_fried")?.pct ?? 0,
      total_items: trends.food_quality.total_items,
    },
  }];
}
