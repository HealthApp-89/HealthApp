// lib/coach/live-session/rule-rest-discipline.ts
//
// Under-resting a heavy compound guarantees the next set underperforms, and
// the athlete then reads that as a strength problem rather than a pacing one.
//
// ExerciseSetDraft.rest_seconds_actual is undefined mid-session, so this rule
// derives rest itself — through the SAME helper that LoggerSheet writes to the
// column, so the MEASUREMENT cannot drift.
//
// The two callers do NOT agree on which set to measure from, and that is
// deliberate: LoggerSheet's commitNow takes the previous COMMITTED set
// (`arr[sIdx - 1]`, warmups included) because rest_seconds_actual is a
// per-row record of the real gap that preceded that row, whatever came
// before it. This rule takes the previous committed NON-WARMUP set, because
// it judges rest against restSecondsFor, which describes inter-WORKING-set
// rest only. They therefore differ on the first working set after a warmup —
// the first exercise of every lifting day. See restBefore for why counting a
// warmup there would false-flag and then, via the once-per-exercise gate,
// permanently silence the rule for that exercise.
//
// That shared helper is restBetweenSets. It measures true rest: from the prior
// set's real end (started_at + work_seconds) to this set's real start. The
// commit-delta it falls back to — for hand-logged sets, Strong imports and any
// row without timer anchors — measures rest PLUS set execution, and since the
// zoomed entry row landed it measures the gap between two arbitrary Save taps,
// which is why it is a fallback and no longer the primary path.
//
// Consequence, and intended: on timed sets this rule now fires on genuinely
// short rests it used to miss, because its input was previously inflated by the
// next set's execution time. UNDER_REST_RATIO is unchanged.
//
// The prescription it compares against rose with the 2026-08-10 rest table
// (heavy compound 180 -> 240, secondary 120 -> 180), so the 0.6 threshold now
// sits at 144s and 108s respectively. Firing more often is the intended
// consequence: the old floors were the bottom of a range nobody honoured.
//
// The "prior set" is always the nearest earlier NON-WARMUP committed set —
// see restBefore for why.
//
// Exercises performed in a superset are excluded outright — see the guard below.

import { tierOf } from "@/lib/coach/session-structure/tiers";
import { restSecondsFor } from "@/lib/coach/session-structure/rules";
import { restBetweenSets } from "@/lib/logger/set-timer";
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
 *  the inter-working-set rest that restSecondsFor describes. Counting a
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
  return restBetweenSets(prior, set);
}

export function ruleRestDiscipline(input: LiveSetInput): CoachLine | null {
  const { set, exercise } = input;

  if (set.warmup) return null;

  // A superset member's rest is not the quantity restSecondsFor describes.
  // Its gap is measured from the previous set of the SAME exercise, which in a
  // superset spans the other member's work as well — comparing that against an
  // inter-working-set prescription judges a number the athlete never chose.
  if (exercise.prescribed.superset) return null;

  // Only heavy compounds. Isolation pacing is the athlete's business.
  const tier = tierOf(exercise.prescribed);
  if (tier !== 1 && tier !== 2) return null;

  const prescribed = restSecondsFor(exercise.prescribed, tier);
  const threshold = prescribed * UNDER_REST_RATIO;

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

  const label = prescribed % 60 === 0
    ? `${prescribed / 60}-minute`
    : `${prescribed}s`;

  return {
    kind: "guardrail",
    text: `${actual}s rest on a ${label} lift. Expect the next set to come up short.`,
    cue: false,
    rule: "rest_discipline",
  };
}
