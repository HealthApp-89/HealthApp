// lib/logger/seed-reps.ts
//
// What rep count is pre-filled into a pending set in the logger draft.
//
// Sibling of seed-rir.ts, and extracted for the same reason: there is no render
// harness in this repo, and the FOUR seeding sites — fresh draft, session reset,
// "+ Add exercise" in the picker, and the card's "+ Add set" — had already
// drifted into agreeing on `null` by copy-paste rather than by decision.

import type { PlannedExercise } from "@/lib/coach/sessionPlans";

/**
 * `prescribed.baseReps`, or null when there is nothing to seed.
 *
 * `kg` has always been seeded from `baseKg` and `rir` from `seedRir`, but reps
 * was left null — which was survivable only while every commit path went
 * through a button that refused to fire on a null rep count. Task 6 added two
 * that do not: the zoom's Save, and the auto-save when START is pressed on the
 * next set. The auto-save MUST NOT block on typing (that coupling is the whole
 * thing Task 6 removes), so the value it commits has to be right by default.
 *
 * A null-reps row is not loud. It passes the route's schema, lands in
 * `exercise_sets`, and then silently drops out of every consumer that needs a
 * rep count: Brzycki e1RM, working-set volume, the debrief, and the weekly
 * prescription engine. Absence there reads as "did not train", not "logged
 * badly".
 *
 * Time-based work (planks, dead hangs, foam rolls) is measured in
 * `duration_seconds` and carries no reps at all — same exclusion `kg` and `rir`
 * already make at these call sites.
 */
export function seedReps(
  prescribed: Pick<PlannedExercise, "baseReps" | "duration_seconds">,
): number | null {
  if (prescribed.duration_seconds != null) return null;
  return prescribed.baseReps ?? null;
}
