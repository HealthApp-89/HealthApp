// lib/coach/proactive/check-bedtime-drift.ts
//
// Fires when bedtime SD over the last 14 days is >75 min. Reads the
// derived stat computed by composeSleepConsistency (Plan 1 Task 7).
// Returns no events if migration 0031 hasn't been backfilled yet
// (bedtime_sd_minutes will be null).

import type { ProactiveEvent } from "@/lib/data/types";
import type { RecoveryIntelligencePayload } from "@/lib/coach/recovery-intelligence/types";
import { BEDTIME_DRIFT_SD_MINUTES } from "@/lib/coach/recovery-intelligence/thresholds";

export function checkBedtimeDrift(p: RecoveryIntelligencePayload): ProactiveEvent[] {
  const sd = p.derived.bedtime_sd_minutes;
  const mean = p.derived.bedtime_mean_minutes;
  if (sd == null) return [];
  if (sd < BEDTIME_DRIFT_SD_MINUTES) return [];

  // Convert mean minutes-after-18 back to HH:MM for the payload.
  const meanHHMM = mean == null ? null : (() => {
    const totalMinutes = (18 * 60 + mean) % (24 * 60);
    const hh = Math.floor(totalMinutes / 60);
    const mm = Math.floor(totalMinutes % 60);
    return `${hh.toString().padStart(2, "0")}:${mm.toString().padStart(2, "0")}`;
  })();

  return [{
    trigger_type: "bedtime_drift",
    trigger_key: "bedtime_drift",
    payload: { sd_minutes_14d: sd, mean_bedtime_hhmm: meanHHMM },
  }];
}
