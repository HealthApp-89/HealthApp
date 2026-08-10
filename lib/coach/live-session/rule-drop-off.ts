// lib/coach/live-session/rule-drop-off.ts
//
// When reps collapse against the best comparable set of the same exercise,
// further sets buy fatigue rather than adaptation. This is a PRACTICAL
// heuristic, not an implementation of the velocity-loss literature: that work
// measures per-rep bar velocity WITHIN a set against a set-opening baseline,
// which no equipment here records. Inter-set rep counts are a coarser,
// noisier stand-in, and the rule is scoped accordingly (see below).
//
// Two scopes keep it from becoming wallpaper:
//
//   1. TIER 1-2 ONLY. On isolation and finisher work (tiers 3-4) a fixed load
//      taken to a fixed RIR is SUPPOSED to bleed reps set over set — a
//      Lateral Raise at baseReps 15 running 15/13/11/10 is a textbook
//      execution of its own prescription, not a stopping signal. Firing there
//      flagged a perfect accessory and, because drop-off outranks the load
//      call, cost the athlete the useful verdict as well. Gating by tier is
//      preferred over simply tightening DROP_OFF_RATIO: the ratio at which
//      decay stops being normal is genuinely different per tier, so one
//      tighter global number would still be wrong in both directions. 25%
//      remains defensible on a heavy compound, where sets are few and rep
//      decay at a fixed load really does track accumulating fatigue.
//   2. ONCE PER EXERCISE, mirroring rule-rest-discipline. Without it the rule
//      re-fired on every set past the third, since the condition stays true
//      once reps have fallen.

import { tierOf } from "@/lib/coach/session-structure/tiers";
import type { CoachLine, LiveSetInput } from "./types";
import type { ExerciseDraft, ExerciseSetDraft } from "@/lib/logger/types";

/** Below this fraction of the best comparable set, the exercise is done. */
const DROP_OFF_RATIO = 0.75;

function isUsable(s: ExerciseSetDraft): boolean {
  return !s.warmup && s.committed_at != null && s.reps != null && s.kg != null;
}

/** Would drop-off have fired on `target`, judged only on the sets committed up
 *  to and including it? Returns the rep trail to narrate, or null.
 *
 *  Evaluating "as of" an arbitrary set is what makes the once-per-exercise gate
 *  possible: the same predicate answers both "does it fire now?" and "did it
 *  already fire earlier?". */
function dropOffTrailAt(
  exercise: ExerciseDraft,
  target: ExerciseSetDraft,
): string | null {
  if (target.warmup) return null;
  if (target.reps == null || target.kg == null) return null;

  const committed = exercise.sets
    .filter(isUsable)
    .filter((s) => s.set_index <= target.set_index)
    .sort((a, b) => a.set_index - b.set_index);
  if (committed.length < 3) return null;

  // Compare only against sets at the same or a heavier load — a light early
  // set is a different effort and must not define the ceiling.
  const comparable = committed.filter((s) => (s.kg as number) >= (target.kg as number));
  if (comparable.length === 0) return null;

  const bestReps = Math.max(...comparable.map((s) => s.reps as number));
  if (bestReps <= 0) return null;
  if (target.reps >= bestReps * DROP_OFF_RATIO) return null;

  return committed
    .slice(-3)
    .map((s) => s.reps)
    .join(" → ");
}

export function ruleDropOff(input: LiveSetInput): CoachLine | null {
  const { set, exercise } = input;

  if (set.warmup) return null;
  if (set.reps == null || set.kg == null) return null;

  // Heavy compounds only — see the header for why accessories are exempt.
  const tier = tierOf(exercise.prescribed);
  if (tier !== 1 && tier !== 2) return null;

  const trail = dropOffTrailAt(exercise, set);
  if (trail == null) return null;

  // Once per exercise: inform, do not nag.
  const alreadyFlagged = exercise.sets.some(
    (s) =>
      !s.warmup &&
      s.committed_at != null &&
      s.set_index < set.set_index &&
      dropOffTrailAt(exercise, s) != null,
  );
  if (alreadyFlagged) return null;

  return {
    kind: "guardrail",
    text: `${trail}. Past the useful range — last set or move on.`,
    cue: false,
    rule: "drop_off",
  };
}
