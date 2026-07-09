// lib/coach/block-outcomes/recalibrate-target.ts
//
// Pure: when a lift is recommended as the next focus, derive its target
// from real data: end_working_kg of the most recent focus block for that
// lift + (observed_step_kg_per_wk × 4 accumulation weeks). Round to step.

import type { PrimaryLift, BlockOutcome } from "@/lib/data/types";
import { roundToStep } from "@/lib/coach/prescription/calibrate-target";

const ACCUMULATION_WEEKS = 4;
const FALLBACK_STEP_KG = 2.5;
const FALLBACK_PROGRESSION_WEEKS = 4;

const STEP_FOR_LIFT: Record<PrimaryLift, number> = {
  squat: 2.5,
  bench: 2.5,
  deadlift: 2.5,
  ohp: 2.5,
};

export function recommendNextTargetKg(opts: {
  lift: PrimaryLift;
  outcomeHistory: BlockOutcome[];
  fallbackWorkingKg: number | null;
}): number | null {
  const { lift, outcomeHistory, fallbackWorkingKg } = opts;

  const lastForLift = outcomeHistory.find((o) => o.primary_lift === lift) ?? null;

  if (lastForLift != null && lastForLift.end_working_kg != null) {
    const observedStep = lastForLift.lessons?.observed_step_kg_per_wk;
    const step = observedStep != null && observedStep > 0 ? observedStep : FALLBACK_STEP_KG;
    const raw = lastForLift.end_working_kg + step * ACCUMULATION_WEEKS;
    return roundToStep(raw, STEP_FOR_LIFT[lift]);
  }

  if (fallbackWorkingKg != null) {
    const raw = fallbackWorkingKg + FALLBACK_STEP_KG * FALLBACK_PROGRESSION_WEEKS;
    return roundToStep(raw, STEP_FOR_LIFT[lift]);
  }

  return null;
}

