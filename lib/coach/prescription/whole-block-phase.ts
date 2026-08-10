// lib/coach/prescription/whole-block-phase.ts
//
// THE block-phase computation. Extracted verbatim out of prescribe-week.ts so
// that every caller who needs "what phase is this block in right now?" reaches
// the same function instead of hand-rolling the inputs.
//
// That extraction is the whole point. Block phase is not one number, it is
// three derivations that have to agree:
//
//   1. WHICH exercise is the focus lift — resolved from the WEEK's session_plan
//      via SESSION_PLANS, not from whatever happens to be in front of the
//      caller. Resolving it from a single day's exercise list makes the same
//      block report a different phase depending on which day you ask.
//   2. `currentWorkingKg` — currentComparisonValueForLift over the engine's
//      28-day window. A longer window reads a lift the athlete has since
//      detrained away from as if it were current: 100 kg pulled in March,
//      working at 85 after a layoff, target 95 → a 180-day max says
//      pre_target and unfreezes load that the weekly engine froze as off_pace.
//   3. `recentProgressionRatePerWeek` — estimateProgressionRate over that same
//      window, in the same value space as (2), so the off_pace
//      required-vs-observed comparison is internally consistent.
//
// Pure: no I/O, no Supabase, safe to import from a browser fetcher.

import type { TrainingBlock, TrainingWeek, PrimaryLift, TargetMetric } from "@/lib/data/types";
import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import { SESSION_PLANS } from "@/lib/coach/sessionPlans";
import { evaluateBlockPhase } from "@/lib/coach/prescription/block-phase-rule";
import {
  currentComparisonValueForLift,
  PRIMARY_LIFT_NAME_PATTERNS,
} from "@/lib/coach/prescription/current-comparison-value";
import { bestComparisonValue } from "@/lib/coach/e1rm";
import type { BlockPhase, WorkoutSetSample } from "@/lib/coach/prescription/types";

/** Reverse map: case-insensitive lookup from exercise name → primary lift.
 *  Exact-name match, never substring: "Romanian Deadlift (Barbell)" CONTAINS
 *  "deadlift" but is Legs day's second hinge, not the deadlift. */
export function inferPrimaryLiftFromName(name: string): PrimaryLift | null {
  const n = name.toLowerCase();
  for (const [lift, patterns] of Object.entries(PRIMARY_LIFT_NAME_PATTERNS) as Array<[PrimaryLift, string[]]>) {
    if (patterns.some((p) => n === p.toLowerCase())) return lift;
  }
  return null;
}

/**
 * Block phase is a whole-block signal: computed once from the focus lift's
 * signals and then applied uniformly to every exercise.
 *
 * `week` is narrowed to the one field actually read, so callers that only have
 * a `session_plan` (the live-session context fetcher) do not have to fabricate
 * a whole TrainingWeek. A real TrainingWeek satisfies it structurally.
 *
 * `recentSets` must be the 28-day window, NEWEST FIRST — estimateProgressionRate
 * reads `samples[0]` as the newest sample.
 */
export function computeWholeBlockPhase(opts: {
  block: TrainingBlock;
  focusLift: PrimaryLift;
  week: Pick<TrainingWeek, "session_plan">;
  recentSets: WorkoutSetSample[];
  rirTarget: number;
  todayIso: string;
}): BlockPhase {
  const { block, focusLift, week, recentSets, rirTarget, todayIso } = opts;

  // Find the first occurrence of the focus lift across the week's session plan.
  const sessionTypes = Object.values(week.session_plan ?? {});
  let focusEx: PlannedExercise | null = null;
  for (const sessionType of sessionTypes) {
    if (sessionType === "REST" || sessionType === "Mobility") continue;
    const exs = SESSION_PLANS[sessionType] ?? [];
    for (const ex of exs) {
      if (inferPrimaryLiftFromName(ex.name) === focusLift) {
        focusEx = ex;
        break;
      }
    }
    if (focusEx) break;
  }

  // If the focus lift isn't in this week's plan, calendar/target signals still
  // determine deload_week and consolidation. off_pace requires the exercise
  // signals so it cannot fire here — that's the safe failure mode.
  if (!focusEx) {
    return evaluateBlockPhase({
      block,
      currentWorkingKg: null,
      recentProgressionRatePerWeek: null,
      todayIso,
    });
  }

  // Comparison value is metric-aware: working_weight blocks compare max kg;
  // e1rm blocks compare max Brzycki e1RM. The same value also drives the
  // progression-rate estimate so the off_pace check is internally consistent.
  const metric: TargetMetric = (block.target_metric as TargetMetric | null) ?? "working_weight";
  const currentValue =
    currentComparisonValueForLift({
      lift: focusLift,
      metric,
      recentSets,
      rirTarget,
      todayIso,
    }) ?? focusEx.baseKg ?? 0;
  return evaluateBlockPhase({
    block,
    currentWorkingKg: currentValue,
    recentProgressionRatePerWeek: estimateProgressionRate(recentSets, focusEx, metric),
    todayIso,
  });
}

/** Estimate weekly progression rate (kg/week OR e1RM/week, depending on
 *  metric) from the user's recent non-warmup sets for this exercise. Used by
 *  evaluateBlockPhase to detect off_pace. Returns 0 when fewer than 2 sets
 *  exist. For e1rm metric, sets whose reps fall outside the 1..12 Brzycki
 *  window are skipped — the slope is computed in the same value-space as
 *  the target comparison so the "required vs observed" math is consistent. */
export function estimateProgressionRate(
  sets: WorkoutSetSample[],
  ex: PlannedExercise,
  metric: TargetMetric,
): number {
  const matching = setsForExercise(sets, ex).slice(0, 8);
  if (matching.length < 2) return 0;
  // Convert each candidate set to its comparison value; skip sets that
  // produce null (rep out of e1RM window).
  const samples = matching
    .map((s) => {
      const v =
        metric === "e1rm"
          ? bestComparisonValue([{ kg: s.kg, reps: s.reps, warmup: false }], "e1rm")
          : s.kg;
      return v == null ? null : { v, performed_on: s.performed_on };
    })
    .filter((x): x is { v: number; performed_on: string } => x != null);
  if (samples.length < 2) return 0;
  const newest = samples[0].v;
  const oldest = samples[samples.length - 1].v;
  const weeks = Math.max(
    1,
    Math.round(dateDiffDays(samples[samples.length - 1].performed_on, samples[0].performed_on) / 7),
  );
  return (newest - oldest) / weeks;
}

function setsForExercise(sets: WorkoutSetSample[], ex: PlannedExercise): WorkoutSetSample[] {
  const target = ex.name.toLowerCase();
  return sets.filter((s) => !s.warmup && s.exercise_name.toLowerCase() === target);
}

function dateDiffDays(a: string, b: string): number {
  const da = new Date(a + "T00:00:00Z").getTime();
  const db = new Date(b + "T00:00:00Z").getTime();
  return Math.abs(db - da) / (24 * 60 * 60 * 1000);
}
