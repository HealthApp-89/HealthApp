// lib/morning/brief/yesterday-vs-plan.ts
//
// Pure composer for the Tue-Sat analytical block. Given yesterday's planned
// session and yesterday's actual workout, produce a per-lift comparison for
// the big-four lifts (Squat / Deadlift / Decline Bench / OHP).
//
// Returns null when yesterday was a planned rest day (nothing to compare).
// When no workout was logged for yesterday, session_logged=false and per_lift
// entries have actual=null + reps_completed_pct=null. The block still renders
// with an explicit "no logged session yesterday" annotation.

import type {
  YesterdayVsPlanBlock,
  TrainingWeek,
  WeeklyReviewRow,
} from "@/lib/data/types";
import { SESSION_PLANS, type PlannedExercise } from "@/lib/coach/sessionPlans";
import { readSessionForDay } from "@/lib/coach/session-plan-reader";
import { BIG_FOUR } from "@/lib/coach/big-four";

/** A single set logged in a workout, in the shape Slice 2a's compose-recap
 *  established (workouts → exercises → exercise_sets via Supabase embedded
 *  select). */
export type LoggedSet = {
  exercise: string;
  kg: number | null;
  reps: number | null;
  warmup: boolean;
};

export type YesterdayWorkoutForBlock = {
  type: string;                       // session label, e.g. "Legs"
  sets: LoggedSet[];                  // flat list across all exercises
};

export type ComposeYesterdayVsPlanInput = {
  yesterdayWeekday: "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";
  trainingWeek: TrainingWeek;         // for prescribed loads (per_lift_intent if any) and session_plan
  review: WeeklyReviewRow;            // for per-lift prescription from the committed review's payload
  yesterdayWorkout: YesterdayWorkoutForBlock | null;
  /** True when the actual session type differs from original_session_plan[yesterday]. */
  swapApplied: boolean;
};

export function composeYesterdayVsPlan(
  input: ComposeYesterdayVsPlanInput,
): YesterdayVsPlanBlock | null {
  const plannedType = readSessionForDay(
    input.trainingWeek.session_plan as Record<string, string>,
    input.yesterdayWeekday,
  );
  if (!plannedType || /^rest$/i.test(plannedType)) {
    // No comparison to make if yesterday was a planned rest day. Caller skips the block.
    return null;
  }

  const sessionLogged = input.yesterdayWorkout !== null;
  const perLift = BIG_FOUR.map((lift) =>
    buildPerLiftEntry(lift, plannedType, input.review, input.yesterdayWorkout),
  ).filter((entry) => entry !== null) as YesterdayVsPlanBlock["per_lift"];

  return {
    schema_version: 1,
    session_logged: sessionLogged,
    swap_applied: input.swapApplied,
    per_lift: perLift,
  };
}

// ── helpers ────────────────────────────────────────────────────────────────

function buildPerLiftEntry(
  lift: string,
  plannedSessionType: string,
  review: WeeklyReviewRow,
  workout: YesterdayWorkoutForBlock | null,
): YesterdayVsPlanBlock["per_lift"][number] | null {
  // The planned per-lift load/sets/reps comes from the committed weekly_review's
  // prescription. If the lift wasn't prescribed for this week, skip it.
  const reviewLift = review.payload?.prescription?.per_lift?.find(
    (p) => p.lift === lift,
  );
  if (!reviewLift) return null;

  // Was this lift even part of yesterday's planned session?
  // SESSION_PLANS[type] enumerates exercises; we check by name.
  const sessionExercises = SESSION_PLANS[plannedSessionType] as PlannedExercise[] | undefined;
  if (!sessionExercises) return null;
  const isInPlannedSession = sessionExercises.some((e) => e.name === lift);
  if (!isInPlannedSession) return null;

  const planned = {
    load_kg: reviewLift.weight_kg,
    sets: reviewLift.sets,
    reps: reviewLift.reps,
    rir_target: review.payload.prescription.rir_target,
  };

  if (workout === null) {
    return {
      lift,
      planned,
      actual: null,
      reps_completed_pct: null,
      rir_target_met: null,
    };
  }

  const liftSets = workout.sets.filter(
    (s) => s.exercise === lift && !s.warmup,
  );

  const setsDone = liftSets.length;

  // Lift was prescribed but not attempted in this otherwise-logged session.
  // Distinguish from "session not logged at all" (which short-circuits above
  // returning actual: null). Here we DO have a workout row but zero working
  // sets for this specific lift — emit nulls for the completion metrics so
  // the AI doesn't misread a skipped lift as a failed RIR target.
  if (setsDone === 0) {
    return {
      lift,
      planned,
      actual: { top_set_load_kg: null, sets_done: 0, total_reps_done: 0 },
      reps_completed_pct: null,
      rir_target_met: null,
    };
  }

  const totalRepsDone = liftSets.reduce((sum, s) => sum + (s.reps ?? 0), 0);
  const topSetLoad = liftSets.reduce<number | null>(
    (max, s) => (s.kg != null && (max === null || s.kg > max) ? s.kg : max),
    null,
  );

  const totalRepsPlanned = planned.sets * planned.reps;
  const repsCompletedPct = totalRepsPlanned > 0 ? totalRepsDone / totalRepsPlanned : null;

  // rir_target_met: heuristic — if total reps done ≥ 90% of planned, treat as met.
  // Stricter logic (per-set RIR) requires per-set rir field on exercise_sets which
  // isn't populated reliably. Document this approximation in the spec; revisit
  // when RIR-per-set logging lands.
  const rirTargetMet =
    repsCompletedPct === null ? null : repsCompletedPct >= 0.9;

  return {
    lift,
    planned,
    actual: {
      top_set_load_kg: topSetLoad,
      sets_done: setsDone,
      total_reps_done: totalRepsDone,
    },
    reps_completed_pct: repsCompletedPct,
    rir_target_met: rirTargetMet,
  };
}
