// lib/coach/proactive/check-monotone-protein.ts
//
// Fires when a single protein source carries ≥70% of the classified
// protein-grams over the last 14 days, with a min-volume gate.

import type { CoachTrendsPayload, ProactiveEvent } from "@/lib/data/types";
import {
  MONOTONE_PROTEIN_SHARE_THRESHOLD,
  QUALITY_MIN_CLASSIFIED_ITEMS,
} from "@/lib/coach/nutrition-intelligence/thresholds";

export function checkMonotoneProtein(trends: CoachTrendsPayload): ProactiveEvent[] {
  if (trends.food_quality.total_items < QUALITY_MIN_CLASSIFIED_ITEMS) return [];
  const sources = trends.food_quality.protein_sources;
  if (sources.length === 0) return [];
  const top = sources[0];
  if (top.pct < MONOTONE_PROTEIN_SHARE_THRESHOLD) return [];
  if (top.category === "unknown") return [];
  return [{
    trigger_type: "monotone_protein",
    trigger_key: "monotone_protein",
    payload: {
      dominant_category: top.category,
      dominant_pct: top.pct,
      dominant_grams: top.grams,
      total_items: trends.food_quality.total_items,
    },
  }];
}
