// lib/coach/session-structure/annotate.ts
//
// Orchestrator. Annotates a PlannedExercise[] with tier/rest/RPE/cue,
// computes ordering warnings, and proposes a suggested reorder when
// violations are present.
//
// Inputs:
//   - exercises: the PlannedExercise[] for today's session (post-resolver,
//     so this may be the static plan or the user's override).
//
// Output: SessionStructure (see types below). All four fields are
// populated deterministically — no AI, no I/O.

import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import { tierOf, type FatigueTier } from "./tiers";
import {
  findOrderingWarnings,
  restPrescription,
  rpePrescription,
  repsForExercise,
  type OrderingWarning,
} from "./rules";
import { suggestReorder } from "./reorder";

export type AnnotatedExercise = PlannedExercise & {
  fatigue_tier: FatigueTier;
  rest_seconds: { min: number; max: number };
  rpe_target: string;
  /** Optional per-exercise cue derived from related warnings (e.g.,
   *  "Pre-fatigued from Triceps Pushdown — expect ~15% strength drop"). */
  cue?: string;
};

export type SessionStructure = {
  exercises: AnnotatedExercise[];
  warnings: OrderingWarning[];
  /** Populated iff warnings.length > 0 AND the suggested reorder validates
   *  clean. Null when the engine can't find a permutation that satisfies
   *  all rules. */
  suggested_order: AnnotatedExercise[] | null;
};

function annotateOne(ex: PlannedExercise): AnnotatedExercise {
  const tier = tierOf(ex);
  const reps = repsForExercise(ex);
  return {
    ...ex,
    fatigue_tier: tier,
    rest_seconds: restPrescription(tier, reps),
    rpe_target: rpePrescription(tier),
  };
}

/** Attach a one-line cue under each AnnotatedExercise whose name matches a
 *  warning. We attach to `warning.exercise` (the affected one), not to the
 *  related one. */
function attachCues(
  annotated: AnnotatedExercise[],
  warnings: OrderingWarning[],
): AnnotatedExercise[] {
  if (warnings.length === 0) return annotated;
  const cueByName = new Map<string, string>();
  for (const w of warnings) {
    // Prefer the rule-2 message (more concrete) when multiple rules touch
    // the same exercise.
    if (w.rule === "bodyweight_finisher_on_fatigued_muscle") {
      cueByName.set(w.exercise, w.message);
    } else if (!cueByName.has(w.exercise)) {
      cueByName.set(w.exercise, w.message);
    }
  }
  return annotated.map((ex) =>
    cueByName.has(ex.name) ? { ...ex, cue: cueByName.get(ex.name) } : ex,
  );
}

export function annotateSession(exercises: PlannedExercise[]): SessionStructure {
  const annotated = exercises.map(annotateOne);
  const warnings = findOrderingWarnings(exercises);
  const withCues = attachCues(annotated, warnings);

  let suggested: AnnotatedExercise[] | null = null;
  if (warnings.length > 0) {
    const proposal = suggestReorder(exercises);
    // Re-validate — if the proposal still violates, drop it.
    const stillBad = findOrderingWarnings(proposal);
    if (stillBad.length === 0) {
      suggested = proposal.map(annotateOne);
    }
  }

  return {
    exercises: withCues,
    warnings,
    suggested_order: suggested,
  };
}
