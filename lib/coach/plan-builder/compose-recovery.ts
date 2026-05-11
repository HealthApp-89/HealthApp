// lib/coach/plan-builder/compose-recovery.ts

import type { IntakePayload, PlanPayload } from "@/lib/data/types";

export function composeRecovery(intake: IntakePayload): PlanPayload["recovery"] {
  // Mobility minutes/week: parse from intake.sleep_recovery.mobility_work if
  // it mentions a frequency; default 30.
  const mobilityWork = intake.sleep_recovery.mobility_work.toLowerCase();
  let mobilityMin = 30;
  const perWeekMatch = mobilityWork.match(/(\d+)\s*(min|minute|minutes)\s*(?:per\s*)?week/);
  const daysMatch = mobilityWork.match(/(\d+)\s*(per|\/)\s*week/);
  if (perWeekMatch) {
    mobilityMin = parseInt(perWeekMatch[1], 10);
  } else if (daysMatch) {
    // Assume ~15 min per session if user says e.g. "3 per week"
    mobilityMin = parseInt(daysMatch[1], 10) * 15;
  }

  return {
    mobility_minutes_per_week: mobilityMin,
    deload_triggers: [
      "HRV outside SWC band 2/4 days",
      "Sleep <6h on 2/4 nights",
      "e1RM drop ≥3% over 2 weeks",
    ],
    reactivity_protocol:
      "If today's readiness < 33%: drop intensity 10%, keep volume. Don't skip the session.",
  };
}
