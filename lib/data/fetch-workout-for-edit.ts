import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export type WorkoutForEditSet = {
  set_index: number;
  kg: number | null;
  reps: number | null;
  duration_seconds: number | null;
  warmup: boolean;
  failure: boolean;
  rir?: number | null;
  rest_seconds_actual: number | null;
};

export type WorkoutForEditExercise = {
  id: string;
  name: string;
  position: number;
  sets: WorkoutForEditSet[];
};

export type WorkoutForEdit = {
  id: string;
  user_id: string;
  date: string;
  type: string | null;
  duration_min: number | null;
  started_at: string | null;
  external_id: string;
  source: string;
  created_at: string;
  exercises: WorkoutForEditExercise[];
};

const QUERY_COLS =
  "id, user_id, date, type, duration_min, started_at, external_id, source, created_at, exercises(id, name, position, exercise_sets(set_index, kg, reps, duration_seconds, warmup, failure, rest_seconds_actual, rir))";

type RawSet = WorkoutForEditSet;
type RawExercise = { id: string; name: string; position: number | null; exercise_sets: RawSet[] | null };
type RawRow = Omit<WorkoutForEdit, "exercises"> & { exercises: RawExercise[] | null };

function shape(row: RawRow): WorkoutForEdit {
  return {
    ...row,
    exercises: (row.exercises ?? [])
      .map((e) => ({
        id: e.id,
        name: e.name,
        position: e.position ?? 0,
        sets: [...(e.exercise_sets ?? [])].sort((a, b) => a.set_index - b.set_index),
      }))
      .sort((a, b) => a.position - b.position),
  };
}

export async function fetchWorkoutForEditServer(
  supabase: SupabaseClient,
  workoutId: string,
): Promise<WorkoutForEdit | null> {
  const { data, error } = await supabase
    .from("workouts")
    .select(QUERY_COLS)
    .eq("id", workoutId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return shape(data as unknown as RawRow);
}

export async function fetchWorkoutForEditBrowser(
  workoutId: string,
): Promise<WorkoutForEdit | null> {
  const supabase = createSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("workouts")
    .select(QUERY_COLS)
    .eq("id", workoutId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return shape(data as unknown as RawRow);
}
