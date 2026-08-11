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
  restSecondsFor,
  rpePrescription,
  REST_SECONDS,
  TRANSITION_BUFFER_SECONDS,
  type OrderingWarning,
} from "./rules";
import { suggestReorder } from "./reorder";
import type { MuscleRegion } from "@/lib/coach/activity/types";
import type { ReactiveRung } from "@/lib/coach/activity/reactive-ladder";

export type AnnotatedExercise = PlannedExercise & {
  fatigue_tier: FatigueTier;
  /** Rest between sets of THIS exercise, in seconds. */
  rest_seconds: number;
  /** Rest to take BEFORE starting this exercise — i.e. after finishing the
   *  previous one. Null on the session's first exercise and on every warm-up
   *  entry. */
  transition_seconds: number | null;
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
  // Per-exercise rir override (e.g. from the activity-aware lighten) wins over
  // the tier-derived RPE band. RPE ≈ 10 − RIR; floor at 1 so a large RIR bump
  // never produces a nonsensical "RPE 0".
  const rpe_target =
    ex.rir != null
      ? `${ex.rir} RIR (RPE ${Math.max(1, 10 - ex.rir)})`
      : rpePrescription(tier);
  return {
    ...ex,
    fatigue_tier: tier,
    rest_seconds: restSecondsFor(ex, tier),
    // Filled in by applyRestPasses, the only place that can see neighbours.
    transition_seconds: null,
    rpe_target,
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
      return `Effort eased on ${regionStr} today — weight unchanged.`;
    case "volume_down":
      return `Volume trimmed on ${regionStr} today — soreness + fatigue.`;
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

/** Neighbour-dependent rest adjustments. Runs on the annotated array in
 *  session order, after annotateOne has set each exercise's own prescription.
 *
 *  Two passes, both of which need to see an exercise's neighbours and so
 *  cannot live in the pure (ex, tier) lookup:
 *
 *  1. The last warm-up before the first working exercise is bumped to
 *     REST_SECONDS.lastWarmup. It is the only thing standing between the
 *     athlete and the heaviest set of the day.
 *  2. transition_seconds — rest before starting this exercise — is the
 *     incoming exercise's own prescription plus a setup buffer. It is set by
 *     the demand of what is COMING, not the fatigue of what just finished.
 *
 *     Only into a tier 1 or 2 exercise. The buffer pays for plate loading and
 *     rack set-up, and buys a fresh start on a lift where arriving fatigued
 *     costs load — neither applies walking to a cable stack. Prescribing it
 *     everywhere produced two minutes between consecutive foam-roll movements
 *     on Mobility day and between curl variations on Arms; into an isolation
 *     or a finisher, that exercise's own rest is already the answer.
 *
 *     Also null on index 0 (nothing precedes it) and on warm-ups (the ramp is
 *     the transition).
 */
function applyRestPasses(annotated: AnnotatedExercise[]): AnnotatedExercise[] {
  return annotated.map((ex, i) => {
    const isWarmup = ex.warmup === true;
    const next = annotated[i + 1];
    const isLastWarmup = isWarmup && next !== undefined && next.warmup !== true;
    const earnsTransition =
      i > 0 && !isWarmup && (ex.fatigue_tier === 1 || ex.fatigue_tier === 2);

    return {
      ...ex,
      rest_seconds: isLastWarmup ? REST_SECONDS.lastWarmup : ex.rest_seconds,
      // Derived from the untouched prescription, never from a bumped value.
      transition_seconds: earnsTransition
        ? ex.rest_seconds + TRANSITION_BUFFER_SECONDS
        : null,
    };
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
  const annotated = applyRestPasses(exercises.map(annotateOne));
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
      // Reordering changes neighbours, so the proposal needs its own pass —
      // otherwise a suggested order ships the original order's transitions.
      suggested = applyRestPasses(proposal.map(annotateOne));
    }
  }

  return {
    exercises: withCues,
    warnings,
    suggested_order: suggested,
  };
}
