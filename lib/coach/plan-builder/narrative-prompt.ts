// Stub: real implementation in Task 11 (lib/coach/plan-builder/narrative-prompt.ts).
// Returns hardcoded empty strings until Task 11 replaces this with the actual
// Anthropic Sonnet call.

import type { IntakePayload, PlanPayload } from "@/lib/data/types";

export type PlanNarrative = {
  goal_summary: string;
  strength_notes: string;
  nutrition_notes: string;
};

type NarrativeInput = {
  intake: IntakePayload;
  skeleton: {
    goal: PlanPayload["goal"];
    strength: PlanPayload["strength"];
    nutrition: PlanPayload["nutrition"];
    sleep: PlanPayload["sleep"];
    recovery: PlanPayload["recovery"];
    coaching_agreement: PlanPayload["coaching_agreement"];
  };
};

export async function generatePlanNarrative(
  _input: NarrativeInput,
): Promise<PlanNarrative> {
  return { goal_summary: "", strength_notes: "", nutrition_notes: "" };
}
