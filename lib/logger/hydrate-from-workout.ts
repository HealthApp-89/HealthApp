import type { PlannedExercise } from "@/lib/coach/sessionPlans";
import type {
  LoggerDraft,
  ExerciseDraft,
  ExerciseSetDraft,
} from "@/lib/logger/types";
import type { WorkoutForEdit } from "@/lib/data/fetch-workout-for-edit";

/**
 * Map a saved logger workout back into a LoggerDraft so LoggerSheet can edit
 * it. The DB workout's external_id is preserved — re-committing upserts the
 * same workouts row (see commit_logger_session RPC).
 *
 * `prescribed` per exercise: look up by name in resolvedPlan; fall back to a
 * bare PlannedExercise with the saved set count.
 */
export function hydrateWorkoutAsDraft(
  workout: WorkoutForEdit,
  resolvedPlan: PlannedExercise[],
): LoggerDraft {
  const committedAt = workout.created_at;
  const nowIso = new Date().toISOString();

  const exercises: ExerciseDraft[] = workout.exercises.map((e, i) => {
    const fromPlan = resolvedPlan.find((p) => p.name === e.name);
    const base: PlannedExercise = fromPlan ?? {
      name: e.name,
      sets: e.sets.length,
      baseReps: e.sets[0]?.reps ?? 10,
    };
    // The saved grouping wins over whatever today's plan says — in BOTH
    // directions. A tag on the row is restored; a NULL column means "performed
    // alone", which is a fact about the past, not a gap for the present to
    // fill. `base` came from today's resolveSessionPlan, so without the strip
    // any pre-branch Arms workout opened in edit mode would silently inherit
    // today's "A"/"B"/"C" pairing and re-commit ten independent lifts as
    // supersets.
    let prescribed: PlannedExercise;
    if (e.superset_group) {
      prescribed = { ...base, superset: e.superset_group };
    } else if (base.superset !== undefined) {
      const { superset: _dropped, ...rest } = base;
      prescribed = rest;
    } else {
      prescribed = base;
    }
    const sets: ExerciseSetDraft[] = e.sets.map((s) => ({
      set_index: s.set_index,
      kg: s.kg,
      reps: s.reps,
      duration_seconds: s.duration_seconds,
      warmup: s.warmup,
      failure: s.failure,
      rir: s.rir ?? null,
      committed_at: committedAt,
      rest_seconds_actual: s.rest_seconds_actual,
      started_at: s.started_at,
      work_seconds: s.work_seconds,
      // Preserved from the STORED row, exactly like superset_group above and
      // for the same reason: whether a set was a top set is a fact about the
      // session that was performed, not something today's plan gets to decide.
      // Dropping it here would silently demote the set on re-commit, and its
      // weight would then re-enter the working-load baseline it was excluded
      // from — see migration 0059.
      is_top_set: s.is_top_set ?? false,
    }));
    return { name: e.name, position: i, prescribed, sets };
  });

  return {
    user_id: workout.user_id,
    session_type: workout.type ?? "Workout",
    date: workout.date,
    duration_min: workout.duration_min,
    started_at: nowIso,
    session_started_at: workout.started_at,
    updated_at: nowIso,
    paused_at: null,
    paused_ms_total: 0,
    exercises,
    resolved_plan: resolvedPlan,
    external_id: workout.external_id,
  };
}
