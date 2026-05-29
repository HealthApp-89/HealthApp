// lib/coach/prescription/autoregulation-rule.ts
//
// Prescribes a non-focus primary lift (or any non-primary compound lift
// not under the block-phase rule) using autoregulation: clean RIR → +step;
// missed once → hold; missed twice → drop 10%. During a focus block, the
// effective load is also clamped to 0.92 × maintenance baseline.

import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import type { BlockPhase } from "@/lib/coach/prescription/types";

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
  /** Block phase governs whole-block discipline. consolidation / off_pace hold
   *  load on secondaries + accessories (mirrors the primary's hold); deload_week
   *  applies the 0.80× + sets/2 deload. Omit or pass "pre_target" for default
   *  autoregulation. */
  blockPhase?: BlockPhase;
};

export function prescribeSecondaryAutoregulated(input: AutoregInput): PlannedExercise {
  const { baseExercise: ex, currentWorkingKg } = input;
  const step = ex.increment?.step ?? 2.5;
  const phase: BlockPhase = input.blockPhase ?? "pre_target";

  // Step 0: block-phase gate — non-pre_target phases override autoregulation so
  // the whole block (not just the primary) honors the phase discipline. See
  // prescribePrimaryFromPhase for the matching primary-lift rules.
  let nextKg: number;
  let setsOverride: number | null = null;
  if (phase === "consolidation" || phase === "off_pace") {
    // Mirror primary's hold: chase reps/volume, never push load.
    nextKg = currentWorkingKg;
  } else if (phase === "deload_week") {
    nextKg = roundToStep(currentWorkingKg * 0.80, step);
    setsOverride = Math.max(1, Math.floor(input.baselineSets / 2));
  } else if (input.consecutiveRirMisses >= 2) {
    // Step 1: standard autoregulation (pre_target phase only).
    nextKg = roundToStep(currentWorkingKg * 0.90, step);
  } else if (input.lastWeekHitRirTargetCleanly) {
    nextKg = currentWorkingKg + step;
  } else {
    nextKg = currentWorkingKg;
  }

  // Step 2: focus-block clamp (still applies in pre_target — protects against
  // jumping in mid-block at a higher prior load).
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

  // Step 3: volume drop during focus block (deload_week overrides above).
  const sets = setsOverride != null
    ? setsOverride
    : input.isFocusBlock
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
