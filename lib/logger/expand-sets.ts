// lib/logger/expand-sets.ts
//
// Turns one PlannedExercise into the set rows the logger opens with.
//
// Lives in lib/ rather than inside LoggerSheet.tsx on purpose: vitest is
// node-environment and scans lib/**/__tests__ only, so anything defined in a
// .tsx is untestable by construction. The set-expansion rules below (top set
// ordering, warmup-only-on-index-0, RIR suppression) are exactly the kind of
// off-by-one logic that needs tests.

import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import type { ExerciseSetDraft } from "@/lib/logger/types";
import { seedReps } from "@/lib/logger/seed-reps";
import { seedRir } from "@/lib/logger/seed-rir";

/**
 * Expand a planned exercise into its opening set drafts.
 *
 * A resolved `topSet` (one with a `kg` — prescribeWeek drops the field
 * entirely when it cannot resolve a load) becomes set_index 0, ahead of the
 * working sets, carrying its own load and rep target. `p.sets` still means the
 * number of WORKING sets, so an exercise with a top set opens with sets + 1
 * rows. That keeps the plan's `sets` meaning one thing everywhere — the volume
 * engine, adherence and the brief all count working sets and would otherwise
 * each need to know whether to add one.
 *
 * The top set is never a warmup: it is the heaviest real effort of the
 * exercise, it counts toward volume, and it is the week's best e1RM data point.
 * It is marked `is_top_set` so the load baselines can exclude it — without that
 * flag its weight would become the next working load (migration 0059).
 */
export function expandPlannedSets(
  p: PlannedExercise,
  weekRirTarget: number | null | undefined,
): ExerciseSetDraft[] {
  const isTimed = p.duration_seconds != null;
  const working = Array.from({ length: p.sets ?? 1 }, (_unused, j) => ({
    set_index: j,
    kg: isTimed ? null : (p.baseKg ?? null),
    // Seeded like kg: the zoom's Save and the auto-save on START both commit
    // without a rep count being typed, and a null-reps row drops silently out
    // of e1RM, volume, the debrief and the prescription engine.
    reps: seedReps(p),
    duration_seconds: null,
    warmup: !!p.warmup && j === 0,
    failure: false,
    // warmups and duration-based exercises carry no RIR
    rir: (!!p.warmup && j === 0) || isTimed ? null : seedRir(p, weekRirTarget),
    committed_at: null,
    is_top_set: false,
  }));

  const top = p.topSet;
  if (top?.kg == null || isTimed || p.warmup) return working;

  const topDraft: ExerciseSetDraft = {
    set_index: 0,
    kg: top.kg,
    reps: top.reps,
    duration_seconds: null,
    warmup: false,
    failure: false,
    // A top set is taken near the limit by design; seeding the week's RIR
    // target (typically 2) would mis-describe it before the athlete edits it.
    rir: null,
    committed_at: null,
    is_top_set: true,
  };

  return [topDraft, ...working.map((s, j) => ({ ...s, set_index: j + 1 }))];
}
