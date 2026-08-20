// lib/coach/prescription/autoregulation-rule.ts
//
// Prescribes a non-focus primary lift (or any non-primary compound lift
// not under the block-phase rule) using autoregulation: clean RIR → +step;
// missed once → hold; missed twice → drop 10%.
//
// FOCUS-BLOCK MAINTENANCE (revised 2026-08-20). A secondary in a focus block
// gets its load HELD at block-entry capacity and its VOLUME cut, not the other
// way round. That ordering is the whole point: the reduced-training literature
// (Bickel et al. and the wider detraining work) is consistent that strength and
// muscle survive large volume cuts as long as INTENSITY is maintained, and that
// cutting load is what actually costs you the adaptation.
//
// This repo tried volume first and abandoned it. From CLAUDE.md: "The prior
// focus-block '-1 set' rule was removed 2026-06-06 — accumulating a set/wk loss
// across 5 weeks on three secondary primaries detrained the patterns too
// aggressively." The failure was that the reduction COMPOUNDED — each week
// subtracted from the already-reduced count, so by week 5 there was nothing
// left. That is a bug in how it was applied, not evidence that volume is the
// wrong lever, and swapping to a 0.92x load cut fixed the symptom by giving up
// the right variable.
//
// So: the clamp multiplier is now 1.0 — a true CEILING that stops a secondary
// climbing mid-block, never an active cut — and the set reduction returns,
// computed against `staticBaselineSets` (SESSION_PLANS) rather than against
// last week's output, so it cannot compound.

import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import type { BlockPhase } from "@/lib/coach/prescription/types";
import { roundToStep } from "@/lib/coach/prescription/calibrate-target";

export type AutoregInput = {
  baseExercise: PlannedExercise;
  currentWorkingKg: number;
  lastWeekHitRirTargetCleanly: boolean;
  consecutiveRirMisses: number; // 0 = clean last week, 1 = missed last week, 2+ = missed two+ in a row
  maintenanceBaselineKg: number | null; // null when not in focus block (no clamp)
  /** During a focus block this is 1.0 — a CEILING at block-entry capacity, not
   *  a reduction. Outside a focus block, pass null to disable the clamp. */
  focusBlockClampMultiplier: number | null;
  baselineSets: number;
  /** Set count from the STATIC template (SESSION_PLANS), which does not move
   *  week to week. The focus-block volume cut is computed against this and
   *  never against `baselineSets` — the latter comes from
   *  discoverEffectiveExercises, which returns the MEDIAN REALIZED set count,
   *  so reducing against it would subtract from an already-reduced number and
   *  compound to nothing across a block. That is exactly the failure that got
   *  the previous "-1 set" rule removed. Omit to disable the volume cut. */
  staticBaselineSets?: number | null;
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
    // MEV-floor maintenance: ceil halves, never drop below 2 working sets.
    // Mirrors block-phase-rule.ts deload_week branch.
    setsOverride = Math.max(2, Math.ceil(input.baselineSets / 2));
  } else if (input.consecutiveRirMisses >= 2) {
    // Step 1: standard autoregulation (pre_target phase only).
    nextKg = roundToStep(currentWorkingKg * 0.90, step);
  } else if (input.lastWeekHitRirTargetCleanly) {
    nextKg = currentWorkingKg + step;
  } else {
    nextKg = currentWorkingKg;
  }

  // Step 2: focus-block CEILING at block-entry capacity. At 1.0 this stops a
  // secondary climbing mid-block without ever pushing it below what the athlete
  // has already demonstrated — the relief comes from Step 3's volume cut.
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

  // Step 3: volume. deload_week's halving wins outright. Otherwise a focus
  // block takes ONE set off the STATIC template count — the maintenance dose
  // that Step 2 deliberately no longer takes out of the load.
  //
  // The subtraction is off `staticBaselineSets`, never `input.baselineSets`.
  // The latter is discovery's median REALIZED count, so it tracks whatever the
  // athlete performed last week — including a previously-reduced prescription.
  // Reducing against it re-reduces every week and converges on the floor, which
  // is precisely how the 2026-06-06 version detrained the secondaries. Anchored
  // to the template, the cut is the same size in week 1 and week 5.
  //
  // Floored at 2 so a 3-set exercise lands at 2 rather than 1: one working set
  // is a token, not a maintenance dose.
  let sets: number;
  if (setsOverride != null) {
    sets = setsOverride;
  } else if (input.isFocusBlock && phase === "pre_target" && input.staticBaselineSets != null) {
    sets = Math.max(2, input.staticBaselineSets - 1);
  } else {
    sets = input.baselineSets;
  }

  return {
    ...ex,
    baseKg: nextKg,
    baseReps: input.baselineReps,
    sets,
  };
}

