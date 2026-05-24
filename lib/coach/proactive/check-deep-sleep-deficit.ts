// lib/coach/proactive/check-deep-sleep-deficit.ts
//
// Fires when 14d deep-sleep avg is <1.0h OR <12% of total sleep.
// Either condition alone fires; not both required.

import type { ProactiveEvent } from "@/lib/data/types";
import type { RecoveryIntelligencePayload } from "@/lib/coach/recovery-intelligence/types";
import {
  DEEP_SLEEP_DEFICIT_HOURS, DEEP_SLEEP_DEFICIT_PCT, DEEP_SLEEP_WINDOW_DAYS,
} from "@/lib/coach/recovery-intelligence/thresholds";

export function checkDeepSleepDeficit(p: RecoveryIntelligencePayload): ProactiveEvent[] {
  const window = p.sleep_architecture.slice(-DEEP_SLEEP_WINDOW_DAYS);
  const deeps = window.map((w) => w.deep_hours).filter((v): v is number => v != null);
  if (deeps.length < 5) return [];

  const avgDeep = deeps.reduce((a, b) => a + b, 0) / deeps.length;

  const totals = window.map((w) => w.total_hours).filter((v): v is number => v != null);
  const avgTotal = totals.length === 0 ? null : totals.reduce((a, b) => a + b, 0) / totals.length;
  const pct = avgTotal && avgTotal > 0 ? avgDeep / avgTotal : null;

  if (avgDeep >= DEEP_SLEEP_DEFICIT_HOURS && (pct == null || pct >= DEEP_SLEEP_DEFICIT_PCT)) {
    return [];
  }

  return [{
    trigger_type: "deep_sleep_deficit",
    trigger_key: "deep_sleep_deficit",
    payload: { avg_deep_h_14d: avgDeep, avg_pct_14d: pct },
  }];
}
