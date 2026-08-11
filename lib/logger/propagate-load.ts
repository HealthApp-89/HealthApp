// lib/logger/propagate-load.ts
//
// A weight typed into one set carries down to the sets below it.
//
// Every working set is pre-filled with the prescription's `baseKg`, so going
// heavier than prescribed used to mean retyping the same number into every
// remaining set by hand — three redundant keyboard trips, mid-workout, between
// sets.
//
// Extracted from ExerciseCard for the same reason as ./apply-target: this repo
// has no render harness (vitest is node-env and scans `lib/**/__tests__` only),
// and index arithmetic over a set list is precisely the band that produced both
// must-fix bugs in the set-timing arc.
//
// SUPERSETS: this operates on ONE exercise's sets, and a superset group spans
// separate ExerciseDrafts, so the two features do not interact. That is a rule,
// not an accident — propagation must never cross into a group partner. Bumping
// the Arnold press does not touch the bicep curl; they are independent loads
// that happen to share a round.
//
// It also takes no timer state, deliberately. The hazard worth checking was
// writing into a set already PERFORMED but not yet committed — one with an open
// entry row, whose `work_seconds` and `started_at` are already stamped. That is
// unreachable within a single exercise: ExerciseCard resolves the open row as
// `timer.pendingEntries.find((e) => e.exerciseIndex === exerciseIndex)`, at most
// one per exercise, because `roundFromLead` picks at most one set per group
// member — and the source of an edit is at or after every other uncommitted set
// in the exercise, since START always leads with the first pending one. So a
// downstream candidate is always a set that has not happened yet. Do not add a
// guard for it; do not delete this paragraph and then add a reachable bug.

import type { ExerciseSetDraft } from "@/lib/logger/types";

/**
 * Apply `newKg` to `sets[fromIndex]` and carry it down to the sets below that
 * still AGREED with that set's previous value. The chain stops at the first
 * candidate that had already diverged — that divergence is the record of a
 * deliberate choice (a back-off, a drop set), and it is the only signal needed.
 * No dirty flags, no extra field on ExerciseSetDraft: the values carry the
 * intent themselves.
 *
 *   before              after (edit set 2 to 110)
 *   S1  100 committed   S1  100   skipped, not overwritten
 *   S2  100             S2  110   the edit
 *   S3  100             S3  110   agreed with old 100 -> follows
 *   S4  100             S4  110   agreed with old 100 -> follows
 *   S5   90             S5   90   diverged -> chain stops here
 *   S6  100             S6  100   below the stop, untouched
 *
 * A CANDIDATE is a set that is uncommitted AND non-warmup. Non-candidates are
 * SKIPPED — never overwritten, and they never break the chain:
 *
 *  - A committed set is history, not a plan. It must not be rewritten, but one
 *    sitting between two pending sets must not sever propagation either.
 *  - A warmup row is the athlete's ramp, not a working load. Warmups sit at the
 *    top of an exercise in practice, but a mid-list one (a re-added set, a badge
 *    toggled by hand) must not stop the chain to the sets below it.
 *
 * Identity-preserving: returns the SAME array when nothing propagates, and the
 * same objects for the sets it does not touch, so ExerciseCard's memo survives.
 *
 * Positions, not `set_index` — the space `ExerciseCard.patchSet` addresses. The
 * two coincide in practice (`removeSet` re-indexes to keep `set_index`
 * contiguous) but the caller's contract is positional, so this is too.
 */
export function propagateLoad(
  sets: readonly ExerciseSetDraft[],
  fromIndex: number,
  newKg: number | null,
): ExerciseSetDraft[] {
  const source = sets[fromIndex];
  if (!source) return sets as ExerciseSetDraft[];

  // A warmup load says nothing about the working sets that follow it.
  if (source.warmup) return sets as ExerciseSetDraft[];

  // Clearing the field must not wipe the rest of the exercise. `null` is a
  // valid ANCHOR (see below) but never a valid thing to propagate.
  if (newKg === null) return sets as ExerciseSetDraft[];

  // A focus-then-blur with no typing reaches here on every tab-through. Nothing
  // changed, so nothing propagates.
  const oldKg = source.kg;
  if (newKg === oldKg) return sets as ExerciseSetDraft[];

  // Which sets below follow. `oldKg === null` is a legitimate anchor — a
  // bodyweight-seeded exercise the athlete starts loading — so candidates
  // holding `null` follow it.
  const followers = new Set<number>();
  for (let i = fromIndex + 1; i < sets.length; i++) {
    const s = sets[i];
    if (s.committed_at != null || s.warmup) continue; // skip, don't stop
    if (s.kg !== oldKg) break;                        // diverged: chain ends
    followers.add(i);
  }

  return sets.map((s, i) => {
    if (i === fromIndex) return { ...s, kg: newKg };
    if (followers.has(i)) return { ...s, kg: newKg };
    return s;
  });
}
