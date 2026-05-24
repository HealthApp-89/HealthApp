// lib/coach/proactive/check-strain-recovery.ts
//
// Fires when 7d avg strain ≥14 AND 7d avg recovery <40%. Classic
// overreach setup — high load + low body-readiness.

import type { ProactiveEvent } from "@/lib/data/types";
import type { RecoveryIntelligencePayload } from "@/lib/coach/recovery-intelligence/types";
import {
  STRAIN_HIGH_AVG_7D, RECOVERY_LOW_AVG_7D,
} from "@/lib/coach/recovery-intelligence/thresholds";

export function checkStrainRecovery(p: RecoveryIntelligencePayload): ProactiveEvent[] {
  const strain = p.derived.strain_avg_7d;
  const recovery = p.derived.recovery_avg_7d;
  if (strain == null || recovery == null) return [];
  if (strain < STRAIN_HIGH_AVG_7D || recovery >= RECOVERY_LOW_AVG_7D) return [];

  return [{
    trigger_type: "strain_recovery_imbalance",
    trigger_key: "strain_recovery_imbalance",
    payload: { strain_avg_7d: strain, recovery_avg_7d: recovery },
  }];
}
