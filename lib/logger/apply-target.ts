// lib/logger/apply-target.ts
//
// Which set does the between-sets coaching line's one-tap load apply to?
//
// Extracted from ExerciseCard so it can be unit-tested: this repo has no
// render harness (vitest is node-env, components are outside the test glob),
// and the first version of this selection shipped a condition that could never
// match anything.

import type { ExerciseSetDraft } from "@/lib/logger/types";

/**
 * Array position of the set a `CoachLine.apply_kg` tap should write into: the
 * FIRST uncommitted set after `fromIndex`. Returns -1 when there is none — the
 * tap then does nothing, which is the correct outcome for a line whose horizon
 * was "next time" rather than "next set".
 *
 * Positions (not `set_index`) throughout, because that is the space
 * `ExerciseCard.patchSet` addresses. The two coincide in practice — `removeSet`
 * re-indexes to keep `set_index` contiguous — but the caller's contract is
 * positional, so this is too.
 *
 * What this guards, precisely:
 *  - `j > fromIndex` — never rewrite the set that produced the line, nor
 *    anything before it. Those are history.
 *  - `committed_at == null` — never rewrite a logged set. A committed kg is a
 *    record of what was lifted, not a plan.
 *
 * What it deliberately does NOT guard: a non-null `kg`. Every pending set is
 * pre-filled with the prescribed `baseKg` at draft creation
 * (`makeDraftFromPlan`), so requiring an empty field made the button a no-op
 * in every real session — the set of lines carrying `apply_kg` and sets with
 * `kg == null` never intersected. The residual risk — overwriting a load the
 * athlete is mid-way through typing into a *later* row while the current row's
 * line is still on screen — is accepted: it takes typing ahead into a row they
 * have not reached, and the tap is their own deliberate action.
 */
export function findApplyTargetSetIndex(
  sets: readonly ExerciseSetDraft[],
  fromIndex: number,
): number {
  for (let j = Math.max(0, fromIndex + 1); j < sets.length; j++) {
    if (sets[j].committed_at == null) return j;
  }
  return -1;
}
