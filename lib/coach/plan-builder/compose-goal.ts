// lib/coach/plan-builder/compose-goal.ts
//
// Composes goal section of plan_payload from intake_payload.
// narrative_summary is left empty here — populated by generatePlanNarrative()
// during the AI pass. feasibility_note is set if sanity_overrides indicate
// the user kept a goal target below current.

import type { IntakePayload, PlanPayload } from "@/lib/data/types";

export function composeGoal(intake: IntakePayload): PlanPayload["goal"] {
  let feasibility_note: string | null = null;
  if (intake.sanity_overrides?.goal_kept_despite_low_target === true) {
    feasibility_note =
      "User acknowledged target is below current e1RM — proceeding against stated value.";
  }
  return {
    type: intake.goals.primary_type,
    primary_metric: intake.goals.primary_metric,
    target_value: intake.goals.target_value,
    target_unit: intake.goals.target_unit,
    target_date: intake.goals.target_date,
    narrative_summary: "", // populated by AI narrative pass
    feasibility_note,
  };
}
