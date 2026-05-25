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
    const prescribed: PlannedExercise = fromPlan ?? {
      name: e.name,
      sets: e.sets.length,
      baseReps: e.sets[0]?.reps ?? 10,
    };
    const sets: ExerciseSetDraft[] = e.sets.map((s) => ({
      set_index: s.set_index,
      kg: s.kg,
      reps: s.reps,
      warmup: s.warmup,
      failure: s.failure,
      committed_at: committedAt,
      rest_seconds_actual: s.rest_seconds_actual,
    }));
    return { name: e.name, position: i, prescribed, sets };
  });

  return {
    user_id: workout.user_id,
    session_type: workout.type,
    date: workout.date,
    started_at: nowIso,
    updated_at: nowIso,
    paused_at: null,
    paused_ms_total: 0,
    exercises,
    resolved_plan: resolvedPlan,
    external_id: workout.external_id,
  };
}
