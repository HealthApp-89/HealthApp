// lib/logger/superset-groups.ts
//
// Which exercises are performed back-to-back, and which sets make up the next
// round. Pure — no React, no clock, no I/O — because the logger's components
// are unreachable by this repo's vitest setup (node environment,
// `lib/**/__tests__` glob) and grouping is exactly the kind of index arithmetic
// that fails silently.
//
// A GROUP is the maximal contiguous run of exercises sharing a `superset` tag.
// Contiguity is the entire rule, and it is load-bearing: a reorder that
// separates two members dissolves the pair, removing a member leaves the
// survivor solo, and two same-tagged exercises that end up apart are simply two
// groups of one. Nothing to validate, no invalid state to represent.
//
// A ROUND is one set from each member of a group — set 1 of each, then set 2 of
// each. Rounds are DERIVED rather than stored, which is what lets an unequal
// pair (3 sets against 2) end with a solo round without a special case.

import type { LoggerDraft, ExerciseDraft } from "@/lib/logger/types";
import { firstPendingSet } from "@/lib/logger/draft-ops";
import type { SetRef } from "@/lib/logger/set-timer";

export type SupersetGroup = {
  /** The shared tag, or null for an exercise performed alone. */
  tag: string | null;
  /** Indices into `draft.exercises`, in performance order. */
  indices: number[];
};

/** Every group in the session, in order. A solo exercise is a one-member
 *  group, so callers never need to branch on "is this a superset". */
export function groupsOf(exercises: Pick<ExerciseDraft, "prescribed">[]): SupersetGroup[] {
  const groups: SupersetGroup[] = [];
  for (let i = 0; i < exercises.length; i++) {
    const tag = exercises[i].prescribed.superset ?? null;
    const prev = groups[groups.length - 1];
    if (prev && tag !== null && prev.tag === tag) {
      prev.indices.push(i);
    } else {
      groups.push({ tag, indices: [i] });
    }
  }
  return groups;
}

/** The group containing `index`. Falls back to a one-member group so callers
 *  can rely on a non-null result for any valid index. */
export function groupOfIndex(
  exercises: Pick<ExerciseDraft, "prescribed">[],
  index: number,
): SupersetGroup {
  const found = groupsOf(exercises).find((g) => g.indices.includes(index));
  return found ?? { tag: exercises[index]?.prescribed.superset ?? null, indices: [index] };
}

/**
 * The sets START should begin: the next uncommitted set, plus the matching set
 * of every other member of its group, in group order.
 *
 * A member with nothing left uncommitted is omitted rather than padded, which
 * is how a 3-set exercise paired with a 2-set one ends on a solo round. Empty
 * result means the session is fully committed and the dock disables START.
 *
 * `skip` carries the refs whose entry row is still open — those sets are
 * uncommitted but already performed, so offering to run them again would count
 * down to a set the caller is about to commit.
 */
export function nextRound(draft: LoggerDraft, skip: SetRef[]): SetRef[] {
  const lead = firstPendingSet(draft, skip);
  if (!lead) return [];
  const group = groupOfIndex(draft.exercises, lead.exerciseIndex);
  const round: SetRef[] = [];
  for (const ei of group.indices) {
    const sets = draft.exercises[ei]?.sets ?? [];
    const si = sets.findIndex(
      (s, i) => !s.committed_at && !skip.some((k) => k.exerciseIndex === ei && k.setIndex === i),
    );
    if (si >= 0) round.push({ exerciseIndex: ei, setIndex: si });
  }
  return round;
}
