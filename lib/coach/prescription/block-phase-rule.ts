// lib/coach/prescription/block-phase-rule.ts
//
// Determines which phase of the block the athlete is in (pre_target /
// consolidation / off_pace / deload_week) and prescribes the primary
// lift's load/reps/sets for next week accordingly.

import type { TrainingBlock } from "@/lib/data/types";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import type { BlockPhase } from "@/lib/coach/prescription/types";

const OFF_PACE_REQUIRED_RATIO = 1.5; // required-rate must exceed observed-rate × 1.5 to be off-pace

/** Returns the block phase based on the athlete's progress and the calendar.
 *  Deload week (week 5) always wins. Otherwise: consolidation if target hit,
 *  off_pace if remaining weeks can't catch up, pre_target otherwise. */
export function evaluateBlockPhase(opts: {
  block: TrainingBlock;
  currentWorkingKg: number | null;
  recentProgressionRatePerWeek: number | null;
  todayIso: string;
}): BlockPhase {
  const week = currentBlockWeek(opts.block, opts.todayIso);
  if (week >= totalBlockWeeks(opts.block)) return "deload_week";
  if (opts.block.target_hit_at_week != null) return "consolidation";

  if (
    opts.currentWorkingKg != null &&
    opts.block.target_value != null &&
    opts.recentProgressionRatePerWeek != null &&
    opts.recentProgressionRatePerWeek > 0
  ) {
    const weeksRemaining = totalBlockWeeks(opts.block) - week;
    if (weeksRemaining <= 0) return "deload_week";
    const required = (opts.block.target_value - opts.currentWorkingKg) / weeksRemaining;
    if (required > opts.recentProgressionRatePerWeek * OFF_PACE_REQUIRED_RATIO) return "off_pace";
  }
  return "pre_target";
}

/** Produces the primary-lift PlannedExercise for next week given the block
 *  phase. The output is a PlannedExercise shape with baseKg/baseReps/sets
 *  populated per the phase rules:
 *   - pre_target:    +step kg if last week RIR target hit cleanly; hold otherwise
 *   - consolidation: hold load, +1 rep target AND +1 set (chase clean volume)
 *   - off_pace:      narrow the deficit — small load jump, optional set drop to compensate fatigue
 *   - deload_week:   load × 0.80, sets cut 50% (rounded down to integer ≥ 1), reps held */
export function prescribePrimaryFromPhase(opts: {
  baseExercise: PlannedExercise; // from session library or recent_workouts; supplies name/key/increment
  phase: BlockPhase;
  currentWorkingKg: number;
  lastWeekHitRirTargetCleanly: boolean;
  rirTarget: number;
  baselineSets: number;
  baselineReps: number;
}): PlannedExercise {
  const { baseExercise: ex, phase, currentWorkingKg } = opts;
  const step = ex.increment?.step ?? 2.5;

  let nextKg = currentWorkingKg;
  let nextReps = opts.baselineReps;
  let nextSets = opts.baselineSets;

  switch (phase) {
    case "pre_target": {
      nextKg = opts.lastWeekHitRirTargetCleanly ? currentWorkingKg + step : currentWorkingKg;
      break;
    }
    case "consolidation": {
      // Consolidation phase: progress ONE variable per week. Reps first; the
      // orchestrator decides at a later week whether reps have hit the top of
      // the prescribed range and a set bump is warranted. Pushing both at once
      // is the classic MRV-breach recipe (Israetel) and defeats the "smallest
      // effective dose" principle (Helms). See spec 2026-05-28 expert review.
      nextKg = currentWorkingKg; // immutable
      nextReps = opts.baselineReps + 1;
      nextSets = opts.baselineSets; // hold sets at baseline
      break;
    }
    case "off_pace": {
      // Off-pace means the realistic catch-up rate has decoupled from the block
      // target. Standard coaching practice (Helms / RP) is to HOLD and signal
      // upstream that the block target needs renegotiation — NOT add load while
      // shedding fatigue capacity. Carter's prompt narrates the off_pace signal
      // and offers to close the block early. The mechanical rule just holds.
      nextKg = currentWorkingKg;
      nextSets = opts.baselineSets;
      break;
    }
    case "deload_week": {
      nextKg = roundToStep(currentWorkingKg * 0.80, step);
      nextSets = Math.max(1, Math.floor(opts.baselineSets / 2));
      break;
    }
  }

  return {
    ...ex,
    baseKg: nextKg,
    baseReps: nextReps,
    sets: nextSets,
  };
}

// ── helpers ──────────────────────────────────────────────────────────

function currentBlockWeek(block: TrainingBlock, todayIso: string): number {
  const start = new Date(block.start_date + "T00:00:00Z");
  const today = new Date(todayIso + "T00:00:00Z");
  const days = Math.floor((today.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
  return Math.max(1, Math.floor(days / 7) + 1);
}

function totalBlockWeeks(block: TrainingBlock): number {
  const start = new Date(block.start_date + "T00:00:00Z");
  const end = new Date(block.end_date + "T00:00:00Z");
  const days = Math.floor((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
  return Math.round(days / 7);
}

function roundToStep(kg: number, step: number): number {
  return Math.round(kg / step) * step;
}
