// lib/coach/live-session/helpers.ts
//
// Predicates shared by more than one live-session rule. Anything used by a
// single rule stays in that rule's module.

import type { ExerciseDraft, ExerciseSetDraft } from "@/lib/logger/types";

/** Three-way effort classification against the prescribed RIR target.
 *
 *  easy     = r >= t + 2. Deliberately NOT r > t: one rep easier than
 *             intended is inside normal RIR-estimation error, and a single
 *             set is weaker evidence than the week of sessions the
 *             prescription engine reasons over. It takes a clear signal to
 *             move a number mid-workout.
 *  on       = t <= r < t + 2
 *  strained = r < t, or the set is flagged as taken to failure
 *
 *  Returns null when RIR was not recorded — the load call stays silent
 *  rather than guessing. */
export function effortBand(
  set: ExerciseSetDraft,
  effortTarget: number,
): "easy" | "on" | "strained" | null {
  if (set.failure) return "strained";
  if (set.rir == null) return null;
  if (set.rir < effortTarget) return "strained";
  if (set.rir >= effortTarget + 2) return "easy";
  return "on";
}

/** True when `set` is the highest-indexed non-warmup set of the exercise.
 *  Compared by set_index rather than object identity: the draft is rebuilt
 *  immutably on every patch, so identity does not survive a commit. */
export function isFinalWorkingSet(
  exercise: ExerciseDraft,
  set: ExerciseSetDraft,
): boolean {
  if (set.warmup) return false;
  const working = exercise.sets.filter((s) => !s.warmup);
  if (working.length === 0) return false;
  const maxIndex = Math.max(...working.map((s) => s.set_index));
  return set.set_index === maxIndex;
}

/** English ordinal for small positive integers ("2nd", "3rd", "11th"). */
export function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}
