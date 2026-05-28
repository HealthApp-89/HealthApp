// lib/coach/prescription/autoregulation-rule.ts
//
// Prescribes a non-focus primary lift (or any non-primary compound lift
// not under the block-phase rule) using autoregulation: clean RIR → +step;
// missed once → hold; missed twice → drop 10%. During a focus block, the
// effective load is also clamped to 0.92 × maintenance baseline.

import type { PlannedExercise } from "@/lib/coach/sessionPlans";

export type AutoregInput = {
  baseExercise: PlannedExercise;
  currentWorkingKg: number;
  lastWeekHitRirTargetCleanly: boolean;
  consecutiveRirMisses: number; // 0 = clean last week, 1 = missed last week, 2+ = missed two+ in a row
  maintenanceBaselineKg: number | null; // null when not in focus block (no clamp)
  /** During a focus block this is 0.92 (gives 0.02 slack vs the 0.90 rule target).
   *  Outside a focus block, pass null to disable the clamp. */
  focusBlockClampMultiplier: number | null;
  baselineSets: number;
  baselineReps: number;
  isFocusBlock: boolean;
};

export function prescribeSecondaryAutoregulated(input: AutoregInput): PlannedExercise {
  const { baseExercise: ex, currentWorkingKg } = input;
  const step = ex.increment?.step ?? 2.5;

  // Step 1: autoregulation choice
  let nextKg: number;
  if (input.consecutiveRirMisses >= 2) {
    nextKg = roundToStep(currentWorkingKg * 0.90, step);
  } else if (input.lastWeekHitRirTargetCleanly) {
    nextKg = currentWorkingKg + step;
  } else {
    nextKg = currentWorkingKg;
  }

  // Step 2: focus-block clamp
  if (
    input.maintenanceBaselineKg != null &&
    input.focusBlockClampMultiplier != null
  ) {
    const ceiling = roundToStep(
      input.maintenanceBaselineKg * input.focusBlockClampMultiplier,
      step,
    );
    if (nextKg > ceiling) nextKg = ceiling;
  }

  // Step 3: volume drop during focus block
  const sets = input.isFocusBlock
    ? Math.max(1, input.baselineSets - 1)
    : input.baselineSets;

  return {
    ...ex,
    baseKg: nextKg,
    baseReps: input.baselineReps,
    sets,
  };
}

function roundToStep(kg: number, step: number): number {
  return Math.round(kg / step) * step;
}
