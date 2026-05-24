// lib/coach/proactive/check-sleep-debt.ts
//
// Fires when 7-day sleep debt (Σ max(0, 8 − actual)) ≥ 5 hours.
// Picks up both "many short nights" and "one zero-sleep crisis" patterns.

import type { ProactiveEvent } from "@/lib/data/types";
import type { RecoveryIntelligencePayload } from "@/lib/coach/recovery-intelligence/types";
import { SLEEP_DEBT_HOURS } from "@/lib/coach/recovery-intelligence/thresholds";

export function checkSleepDebt(p: RecoveryIntelligencePayload): ProactiveEvent[] {
  const debt = p.derived.sleep_debt_7d_hours;
  if (debt == null || debt < SLEEP_DEBT_HOURS) return [];

  const last7 = p.daily.slice(-7).map((d) => d.sleep_hours).filter((v): v is number => v != null);
  const avg = last7.length === 0 ? null : last7.reduce((a, b) => a + b, 0) / last7.length;

  return [{
    trigger_type: "sleep_debt_accumulated",
    trigger_key: "sleep_debt_accumulated",
    payload: { debt_hours_7d: debt, avg_hours_7d: avg },
  }];
}
