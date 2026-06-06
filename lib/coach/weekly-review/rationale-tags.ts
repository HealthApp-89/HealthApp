// lib/coach/weekly-review/rationale-tags.ts
//
// Re-derives a v2 PrescriptionRationaleTag from the engine's output shape,
// for narration in the weekly-review payload. Pure function — given the
// block phase, last week's load, and the engine's prescribed load + rep
// targets, it picks the tag that names the rule the engine applied.
//
// Why re-derive in the mapper instead of mutating the engine output: the
// canonical engine emits PlannedExercise[], not annotated decisions. Adding
// a tag field to PrescribedExercise would leak the payload taxonomy into
// the rule layer. The phase + delta is enough to reconstruct the tag
// deterministically.

import type { BlockPhase } from "@/lib/coach/prescription/types";
import type { PrescriptionRationaleTag } from "@/lib/data/types";

export function deriveRationaleTag(opts: {
  blockPhase: BlockPhase;
  prescribedKg: number;
  prescribedReps: number;
  prescribedSets: number;
  lastWeekKg: number | null;
  lastWeekReps: number | null;
  lastWeekSets: number | null;
}): PrescriptionRationaleTag {
  const {
    blockPhase, prescribedKg, prescribedReps, prescribedSets,
    lastWeekKg, lastWeekReps, lastWeekSets,
  } = opts;

  if (blockPhase === "deload_week") return "deload_floor";

  if (blockPhase === "off_pace") return "off_pace_hold";

  if (blockPhase === "consolidation") {
    return "consolidation_hold_progress_reps";
  }

  // pre_target — step or hold
  if (lastWeekKg == null) return "pre_target_step"; // first observation; treat as a step

  // Tolerance: 0.01 kg covers float-rounding noise without masking real holds.
  const kgChanged = Math.abs(prescribedKg - lastWeekKg) > 0.01;
  if (kgChanged) return "pre_target_step";

  // Same kg — but maybe reps/sets bumped (still a meaningful step).
  if (lastWeekReps != null && prescribedReps > lastWeekReps) return "pre_target_step";
  if (lastWeekSets != null && prescribedSets > lastWeekSets) return "pre_target_step";

  return "pre_target_hold";
}
