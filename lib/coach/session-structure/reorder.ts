// lib/coach/session-structure/reorder.ts
//
// Stable suggested-reorder algorithm. Goal: produce a permutation of the
// input that minimizes ordering-rule violations.
//
// Algorithm (intentionally simple, not optimal):
//   1. Partition into two zones: warm-ups (warmup === true) up front, rest after.
//   2. Within the post-warmup zone, stable-sort by:
//      - fatigue_tier ascending (1 → 2 → 3 → 4),
//      - within same tier: BIG_FOUR before non-BIG_FOUR.
//   3. Concatenate warmups + sorted post-warmup.
//
// This handles:
//   - tier_ascending (rule 1) — explicit sort key
//   - big_four_first (rule 3) — secondary sort key
//
// It does NOT fully address rule 2 (bodyweight_finisher_on_fatigued_muscle)
// beyond moving tier-4 items to the end, where they belong by tier alone. In
// the rare case where the suggested order still violates rule 2 (e.g. every
// tier-3 in the session shares a primary muscle with the tier-4 finisher),
// the orchestrator (annotate.ts) re-runs findOrderingWarnings on the
// suggested order; if warnings remain, suggested_order is set to null and
// the banner shows the warnings without an Apply chip.

import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import { tierOf, BIG_FOUR_SET } from "./tiers";

/** Stable sort by (tier asc, BIG_FOUR-first within tier). Returns a new
 *  PlannedExercise[] with the same length and contents as input. */
export function suggestReorder(exercises: PlannedExercise[]): PlannedExercise[] {
  const warmups = exercises.filter((e) => e.warmup === true);
  const rest = exercises.filter((e) => e.warmup !== true);

  // Stable sort: attach original index, sort, drop index.
  const indexed = rest.map((ex, idx) => ({ ex, idx }));
  indexed.sort((a, b) => {
    const ta = tierOf(a.ex);
    const tb = tierOf(b.ex);
    if (ta !== tb) return ta - tb;
    // Same tier — BIG_FOUR first.
    const aIsBig = BIG_FOUR_SET.has(a.ex.name);
    const bIsBig = BIG_FOUR_SET.has(b.ex.name);
    if (aIsBig !== bIsBig) return aIsBig ? -1 : 1;
    // Stable fallback: original order.
    return a.idx - b.idx;
  });

  return [...warmups, ...indexed.map((x) => x.ex)];
}
