// lib/coach/plan-builder/compose-coaching-agreement.ts

import type { IntakePayload, PlanPayload } from "@/lib/data/types";

export function composeCoachingAgreement(
  intake: IntakePayload,
): PlanPayload["coaching_agreement"] {
  const prefs = intake.coaching_preferences;
  return {
    cadence: prefs?.cadence ?? "weekly",
    directness: prefs?.directness ?? "balanced",
    unprompted_actions_allowed: prefs?.unprompted_actions ?? [],
    re_evaluation_cadence_weeks: 8,
  };
}
