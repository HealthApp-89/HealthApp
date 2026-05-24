// lib/coach/proactive/check-low-recovery-streak.ts
//
// Fires when recovery has been <34% for 4+ consecutive days ending today.
// Single low-recovery days are noise; 4+ in a row is a pattern.

import type { ProactiveEvent } from "@/lib/data/types";
import type { RecoveryIntelligencePayload } from "@/lib/coach/recovery-intelligence/types";
import {
  RECOVERY_LOW_TIER, LOW_RECOVERY_STREAK_DAYS,
} from "@/lib/coach/recovery-intelligence/thresholds";

export function checkLowRecoveryStreak(p: RecoveryIntelligencePayload): ProactiveEvent[] {
  // Walk backward from today, count consecutive low days.
  let streak = 0;
  const sum: number[] = [];
  for (let i = p.daily.length - 1; i >= 0; i--) {
    const r = p.daily[i].recovery;
    if (r == null) break;
    if (r >= RECOVERY_LOW_TIER) break;
    streak++;
    sum.push(r);
  }
  if (streak < LOW_RECOVERY_STREAK_DAYS) return [];

  const avg = sum.reduce((a, b) => a + b, 0) / sum.length;
  return [{
    trigger_type: "low_recovery_streak",
    trigger_key: "low_recovery_streak",
    payload: { streak_days: streak, avg_recovery_pct: avg },
  }];
}
