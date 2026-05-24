// lib/coach/proactive/check-sickness-lingering.ts
//
// Fires when sick=true on 4+ consecutive checkins ending today. This is
// the "consider doctor visit" prompt, not the "you're sick today" prompt.

import type { ProactiveEvent } from "@/lib/data/types";
import type { RecoveryIntelligencePayload } from "@/lib/coach/recovery-intelligence/types";
import { SICKNESS_LINGERING_DAYS } from "@/lib/coach/recovery-intelligence/thresholds";

export function checkSicknessLingering(p: RecoveryIntelligencePayload): ProactiveEvent[] {
  let streak = 0;
  let latest_notes: string | null = null;
  for (let i = p.subjective.length - 1; i >= 0; i--) {
    if (!p.subjective[i].sick) break;
    streak++;
    if (latest_notes === null) latest_notes = p.subjective[i].sickness_notes;
  }
  if (streak < SICKNESS_LINGERING_DAYS) return [];

  return [{
    trigger_type: "sickness_lingering",
    trigger_key: "sickness_lingering",
    payload: { streak_days: streak, latest_notes },
  }];
}
