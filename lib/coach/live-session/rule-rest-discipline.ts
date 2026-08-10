// lib/coach/live-session/rule-rest-discipline.ts
//
// Under-resting a heavy compound guarantees the next set underperforms, and
// the athlete then reads that as a strength problem rather than a pacing one.
//
// ExerciseSetDraft.rest_seconds_actual is undefined mid-session — it is
// derived from committed_at deltas at commit time. This rule derives it the
// same way so the live number matches the one eventually persisted. Note that
// both measure commit-to-commit (rest plus set execution), not pure rest.
//
// The "prior set" is always the nearest earlier NON-WARMUP committed set —
// see restBefore for why.

import { tierOf } from "@/lib/coach/session-structure/tiers";
import { restPrescription, repsForExercise } from "@/lib/coach/session-structure/rules";
import type { CoachLine, LiveSetInput } from "./types";
import type { ExerciseDraft, ExerciseSetDraft } from "@/lib/logger/types";

/** Below this fraction of the prescribed minimum, the next set will suffer. */
const UNDER_REST_RATIO = 0.6;

/** Seconds between the previous committed WORKING set and this one, or null
 *  when there is no prior committed working set to measure from.
 *
 *  Warmup sets are deliberately excluded from candidacy, on both sides of the
 *  comparison. Every lifting day's first exercise carries warmup sets in the
 *  SAME exercise.sets[] / set_index space as the working sets, and the
 *  warmup-to-first-working-set transition is legitimately short — it is not
 *  the inter-working-set rest that restPrescription describes. Counting a
 *  warmup as the "prior" set would false-flag that transition and, via the
 *  once-per-exercise gate below, permanently suppress the rule for the rest
 *  of the exercise. The accepted consequence: the first working set of an
 *  exercise has no prior working set yet, so the rule correctly stays silent
 *  there — there is nothing to judge until a second working set exists. */
function restBefore(
  exercise: ExerciseDraft,
  set: ExerciseSetDraft,
): number | null {
  if (set.committed_at == null) return null;
  const prior = exercise.sets
    .filter((s) => !s.warmup && s.committed_at != null && s.set_index < set.set_index)
    .sort((a, b) => b.set_index - a.set_index)[0];
  if (!prior?.committed_at) return null;
  const delta = Date.parse(set.committed_at) - Date.parse(prior.committed_at);
  if (!Number.isFinite(delta) || delta < 0) return null;
  return Math.round(delta / 1000);
}

export function ruleRestDiscipline(input: LiveSetInput): CoachLine | null {
  const { set, exercise } = input;

  if (set.warmup) return null;

  // Only heavy compounds. Isolation pacing is the athlete's business.
  const tier = tierOf(exercise.prescribed);
  if (tier !== 1 && tier !== 2) return null;

  const reps = repsForExercise(exercise.prescribed);
  const threshold = restPrescription(tier, reps).min * UNDER_REST_RATIO;

  const actual = restBefore(exercise, set);
  if (actual == null) return null;
  if (actual >= threshold) return null;

  // Once per exercise: inform, do not nag. Only earlier WORKING sets count —
  // a warmup can never itself be the flagged set.
  const alreadyFlagged = exercise.sets.some((s) => {
    if (s.warmup) return false;
    if (s.set_index >= set.set_index) return false;
    const r = restBefore(exercise, s);
    return r != null && r < threshold;
  });
  if (alreadyFlagged) return null;

  const prescribedMin = restPrescription(tier, reps).min;
  const label = prescribedMin % 60 === 0
    ? `${prescribedMin / 60}-minute`
    : `${prescribedMin}s`;

  return {
    kind: "guardrail",
    text: `${actual}s rest on a ${label} lift. Expect the next set to come up short.`,
    cue: false,
    rule: "rest_discipline",
  };
}
