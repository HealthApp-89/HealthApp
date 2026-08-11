// lib/coach/prescription/superset-sets.ts
//
// A superset's members are performed as rounds, so their set counts have to
// match. Nothing upstream guarantees that: the volume engine assigns sets per
// EXERCISE from each muscle's realized volume, so a pair whose members hit
// different muscles drifts apart the moment one of them is short. Friday's
// Arms day did exactly that — biceps read below target, so Bicep Curl and
// Hammer Curl went to 4 while their shoulder partners stayed at 3, and the
// logger produced three clean rounds followed by an orphan curl set.
//
// Runs LAST in the per-day pipeline, after both the athlete's block-scope
// structure overrides and the activity-lighten pass, because either can
// desync a pair on its own — lighten trims by muscle region, which is exactly
// the axis a mixed-muscle pair straddles.

import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import { groupsOf } from "@/lib/logger/superset-groups";

/**
 * Equalize set counts within every superset group, to the group's max.
 *
 * Max, not min: the count came from a muscle that the volume engine judged
 * short, and dropping it to match the partner would discard that judgement
 * silently. Raising the partner keeps the pairing honest and leaves the
 * decision visible — an athlete who does not want the extra set caps it with
 * a structure override, and that cap is what the next run equalizes around.
 *
 * Group membership is `groupsOf` — the same maximal-contiguous-run rule the
 * logger uses to decide what a round is — so the engine and the logger cannot
 * disagree about which exercises form a pair.
 *
 * Warm-ups never participate: `augmentFirstLoadedCompoundWithWarmups` drops
 * the superset tag when it builds them, so they are always solo groups here.
 */
export function equalizeSupersetSets(exercises: PlannedExercise[]): PlannedExercise[] {
  const groups = groupsOf(exercises.map((prescribed) => ({ prescribed })));
  let out = exercises;

  for (const group of groups) {
    if (group.indices.length < 2) continue;

    const counts = group.indices
      .map((i) => exercises[i].sets)
      .filter((n): n is number => typeof n === "number");
    // Nothing to equalize around — leave `sets` undefined rather than
    // inventing a count the plan never carried.
    if (counts.length === 0) continue;

    const target = Math.max(...counts);
    if (group.indices.every((i) => exercises[i].sets === target)) continue;

    // Clone lazily: an already-consistent session is handed back untouched, so
    // callers comparing identity see no spurious change.
    if (out === exercises) out = exercises.map((e) => ({ ...e }));
    for (const i of group.indices) out[i].sets = target;
  }

  return out;
}
