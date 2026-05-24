// lib/coach/proactive/check-post-strain-undersleep.ts
//
// Fires when there are 2+ pairs in the last 14d where day N had strain
// ≥15 and day N+1 had sleep_hours <7. Coaching cue: protect post-hard-day
// sleep.

import type { ProactiveEvent } from "@/lib/data/types";
import type { RecoveryIntelligencePayload } from "@/lib/coach/recovery-intelligence/types";
import {
  POST_STRAIN_THRESHOLD, POST_STRAIN_SLEEP_FLOOR_H,
  POST_STRAIN_OCCURRENCES, POST_STRAIN_WINDOW_DAYS,
} from "@/lib/coach/recovery-intelligence/thresholds";

export function checkPostStrainUndersleep(p: RecoveryIntelligencePayload): ProactiveEvent[] {
  const window = p.daily.slice(-POST_STRAIN_WINDOW_DAYS);
  const pairs: Array<{ strain_date: string; strain: number; sleep_date: string; sleep_h: number }> = [];
  for (let i = 0; i < window.length - 1; i++) {
    const a = window[i];
    const b = window[i + 1];
    if (a.strain == null || b.sleep_hours == null) continue;
    if (a.strain >= POST_STRAIN_THRESHOLD && b.sleep_hours < POST_STRAIN_SLEEP_FLOOR_H) {
      pairs.push({ strain_date: a.date, strain: a.strain, sleep_date: b.date, sleep_h: b.sleep_hours });
    }
  }
  if (pairs.length < POST_STRAIN_OCCURRENCES) return [];

  return [{
    trigger_type: "post_strain_undersleep",
    trigger_key: "post_strain_undersleep",
    payload: { occurrences: pairs.length, pairs },
  }];
}
