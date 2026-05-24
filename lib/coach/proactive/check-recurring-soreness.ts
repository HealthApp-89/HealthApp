// lib/coach/proactive/check-recurring-soreness.ts
//
// Fires when a single body region appears in soreness_areas for 5+ of
// the last 14 checkins. 'sharp' counts double for severity weighting,
// so 3 sharps + 2 mild = 8 score (still triggers).

import type { ProactiveEvent } from "@/lib/data/types";
import type { RecoveryIntelligencePayload } from "@/lib/coach/recovery-intelligence/types";
import {
  RECURRING_SORENESS_OCCURRENCES, RECURRING_SORENESS_WINDOW_DAYS,
} from "@/lib/coach/recovery-intelligence/thresholds";

export function checkRecurringSoreness(p: RecoveryIntelligencePayload): ProactiveEvent[] {
  const window = p.subjective.slice(-RECURRING_SORENESS_WINDOW_DAYS);
  const tallies: Record<string, { count: number; score: number }> = {};
  for (const day of window) {
    const weight = day.soreness_severity === "sharp" ? 2 : 1;
    for (const area of day.soreness_areas) {
      tallies[area] = tallies[area] ?? { count: 0, score: 0 };
      tallies[area].count += 1;
      tallies[area].score += weight;
    }
  }
  const out: ProactiveEvent[] = [];
  for (const [area, { count, score }] of Object.entries(tallies)) {
    if (count >= RECURRING_SORENESS_OCCURRENCES) {
      out.push({
        // Per-area key: 'recurring_soreness_legs', etc. Distinct dedup
        // windows per area so chest + legs can both fire same day.
        trigger_type: "recurring_soreness_area",
        trigger_key: `recurring_soreness_${area}`,
        payload: { area, occurrences: count, severity_weighted_score: score },
      });
    }
  }
  return out;
}
