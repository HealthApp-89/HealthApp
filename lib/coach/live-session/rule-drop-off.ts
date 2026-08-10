// lib/coach/live-session/rule-drop-off.ts
//
// Rep drop-off at a fixed load is the practical proxy for velocity loss, the
// standard in-session stopping criterion. Once reps fall far enough below the
// best set at the same-or-heavier load, further sets buy fatigue, not
// adaptation.

import type { CoachLine, LiveSetInput } from "./types";
import type { ExerciseSetDraft } from "@/lib/logger/types";

/** Below this fraction of the best comparable set, the exercise is done. */
const DROP_OFF_RATIO = 0.75;

function isUsable(s: ExerciseSetDraft): boolean {
  return !s.warmup && s.committed_at != null && s.reps != null && s.kg != null;
}

export function ruleDropOff(input: LiveSetInput): CoachLine | null {
  const { set, exercise } = input;

  if (set.warmup) return null;
  if (set.reps == null || set.kg == null) return null;

  const committed = exercise.sets.filter(isUsable);
  if (committed.length < 3) return null;

  // Compare only against sets at the same or a heavier load — a light early
  // set is a different effort and must not define the ceiling.
  const comparable = committed.filter((s) => (s.kg as number) >= (set.kg as number));
  if (comparable.length === 0) return null;

  const bestReps = Math.max(...comparable.map((s) => s.reps as number));
  if (bestReps <= 0) return null;
  if (set.reps >= bestReps * DROP_OFF_RATIO) return null;

  const trail = committed
    .slice(-3)
    .map((s) => s.reps)
    .join(" → ");

  return {
    kind: "guardrail",
    text: `${trail}. Past the useful range — last set or move on.`,
    cue: false,
    rule: "drop_off",
  };
}
