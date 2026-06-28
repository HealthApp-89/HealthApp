// lib/coach/session-structure/annotate.ts
//
// Orchestrator. Annotates a PlannedExercise[] with tier/rest/RPE/cue,
// computes ordering warnings, and proposes a suggested reorder when
// violations are present.
//
// Inputs:
//   - exercises: the PlannedExercise[] for today's session (post-resolver,
//     so this may be the static plan or the user's override).
//   - context (optional): soreness context from the reactive ladder.
//     When absent, behavior is byte-identical to the stateless path.
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
import type { MuscleRegion } from "@/lib/coach/activity/types";
import type { ReactiveRung } from "@/lib/coach/activity/reactive-ladder";

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

/** Optional soreness context passed by the morning brief assembler.
 *  When absent, annotateSession is byte-identical to the stateless path. */
export type AnnotateContext = {
  /** Sore muscle regions from this morning's intake. */
  soreRegions: MuscleRegion[];
  /** The reactive rung selected by selectReactiveRung. */
  rung: ReactiveRung;
};

/** Per-exercise region hints derived from SESSION_PLANS session categories.
 *  Used to decide which exercises in the session overlap the sore regions.
 *  Maps lowercased substrings in exercise names to the regions they load.
 *  This is intentionally coarse — exact per-exercise region tables are a
 *  Phase 2 concern; for Phase 1 the session-level hint is sufficient. */
const EXERCISE_REGION_HINTS: Array<{ pattern: RegExp; regions: MuscleRegion[] }> = [
  { pattern: /squat|leg press|hip thrust|rdl|romanian|leg curl|leg extension|lunge|calf/i, regions: ["legs", "lower_back"] },
  { pattern: /deadlift/i, regions: ["back", "lower_back", "legs"] },
  { pattern: /bench|chest fly|push.?up|push.?down|dip|tricep/i, regions: ["chest", "shoulders", "arms"] },
  { pattern: /lat\b|pulldown|pull.?up|row|pullover/i, regions: ["back", "arms"] },
  { pattern: /ohp|overhead|shoulder press|lateral raise|rear delt|face pull|arnold/i, regions: ["shoulders", "arms"] },
  { pattern: /curl|hammer|preacher/i, regions: ["arms"] },
  { pattern: /plank|core|ab |crunch|hollow/i, regions: ["core"] },
];

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

/** Returns the MuscleRegion[] for an exercise based on its name.
 *  Returns [] for exercises that match no hint (e.g. stretches). */
function exerciseRegions(name: string): MuscleRegion[] {
  const regions = new Set<MuscleRegion>();
  for (const { pattern, regions: r } of EXERCISE_REGION_HINTS) {
    if (pattern.test(name)) {
      for (const reg of r) regions.add(reg);
    }
  }
  return Array.from(regions);
}

/** Build a soreness cue string for an exercise given the rung. */
function sorenessAwareCue(rung: ReactiveRung, soreRegions: MuscleRegion[]): string {
  const regionStr = soreRegions.join(", ");
  switch (rung) {
    case "load_down":
      return `Soreness in ${regionStr} — drop weight ~10% and listen to your body.`;
    case "volume_down":
      return `Soreness + fatigue in ${regionStr} — cut 1 set if needed.`;
    case "swap_exercise":
      return `Soreness in ${regionStr} — consider substituting this exercise today.`;
    case "swap_day":
      return `Sharp soreness in ${regionStr} — session replacement recommended (see suggestion chip).`;
    default:
      return "";
  }
}

/** Attach soreness cues from the reactive-ladder context to exercises whose
 *  regions overlap the sore regions. No-op when context is absent or rung
 *  is "none". Preserves existing ordering-warning cues — soreness cue only
 *  appended when no ordering cue is already present. */
function attachSorenessCues(
  annotated: AnnotatedExercise[],
  context: AnnotateContext | undefined,
): AnnotatedExercise[] {
  if (!context || context.rung === "none" || context.soreRegions.length === 0) {
    return annotated;
  }
  const { soreRegions, rung } = context;
  const soreSet = new Set(soreRegions);
  return annotated.map((ex) => {
    // Skip warmup exercises — they're low-load and shouldn't be interrupted
    if (ex.warmup) return ex;
    const exRegions = exerciseRegions(ex.name);
    const overlaps = exRegions.some((r) => soreSet.has(r));
    if (!overlaps) return ex;
    // Preserve existing ordering-warning cue when present; append soreness
    // cue only when the exercise doesn't already carry one.
    if (ex.cue) return ex;
    const cue = sorenessAwareCue(rung, soreRegions.filter((r) => exRegions.includes(r)));
    return cue ? { ...ex, cue } : ex;
  });
}

/**
 * Annotate a session's exercises with tier, rest seconds, RPE target, and
 * optional cues.
 *
 * @param exercises  The PlannedExercise[] for today's session.
 * @param context    Optional soreness context from the reactive ladder.
 *                   When absent, behavior is byte-identical to the
 *                   stateless (no-context) path — existing tests pass
 *                   without modification.
 */
export function annotateSession(
  exercises: PlannedExercise[],
  context?: AnnotateContext,
): SessionStructure {
  const annotated = exercises.map(annotateOne);
  const warnings = findOrderingWarnings(exercises);
  const withOrderCues = attachCues(annotated, warnings);
  // Apply soreness cues on top of (but not replacing) ordering-warning cues.
  const withCues = attachSorenessCues(withOrderCues, context);

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
