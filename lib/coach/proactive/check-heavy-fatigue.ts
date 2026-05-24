// lib/coach/proactive/check-heavy-fatigue.ts
//
// Fires when fatigue='heavy' on 3+ of the last 7 checkins. Subjective
// counterpart to the HRV chronic check — catches cases where objective
// numbers are fine but the athlete feels wrecked (life stress, illness
// brewing, sleep quality crash that score didn't catch).

import type { ProactiveEvent } from "@/lib/data/types";
import type { RecoveryIntelligencePayload } from "@/lib/coach/recovery-intelligence/types";
import {
  HEAVY_FATIGUE_DAYS, HEAVY_FATIGUE_WINDOW_DAYS,
} from "@/lib/coach/recovery-intelligence/thresholds";

export function checkHeavyFatigue(p: RecoveryIntelligencePayload): ProactiveEvent[] {
  const window = p.subjective.slice(-HEAVY_FATIGUE_WINDOW_DAYS);
  const heavyDays = window.filter((s) => s.fatigue === "heavy");
  if (heavyDays.length < HEAVY_FATIGUE_DAYS) return [];

  return [{
    trigger_type: "heavy_fatigue_cluster",
    trigger_key: "heavy_fatigue_cluster",
    payload: {
      heavy_days_count: heavyDays.length,
      dates: heavyDays.map((d) => d.date),
    },
  }];
}
