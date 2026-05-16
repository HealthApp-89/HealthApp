// lib/coach/proactive/check-plateau.ts
//
// Emits one ProactiveEvent per big-four lift with plateau_active=true.
// Reads only from the pre-computed CoachTrendsPayload.strength.per_lift[].
// The plateau detection itself lives in lib/coach/trends/compose-strength.ts
// (3+ consecutive non-deload weeks within 1.5% of each other).

import type { CoachTrendsPayload, ProactiveEvent } from "@/lib/data/types";

export function checkPlateau(
  trends: CoachTrendsPayload,
): ProactiveEvent[] {
  const events: ProactiveEvent[] = [];
  for (const lift of trends.strength.per_lift) {
    if (!lift.plateau_active) continue;
    events.push({
      trigger_type: "plateau",
      trigger_key: `plateau:${lift.lift}`,
      payload: {
        lift: lift.lift,
        e1rm_kg_now: lift.e1rm_kg_now,
        plateau_weeks_flat: lift.plateau_weeks_flat,
      },
    });
  }
  return events;
}
