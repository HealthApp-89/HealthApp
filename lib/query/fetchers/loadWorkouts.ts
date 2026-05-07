// lib/query/fetchers/loadWorkouts.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import {
  WORKOUT_QUERY_COLS,
  processRawWorkouts,
  type RawWorkoutRow,
  type WorkoutSession,
} from "@/lib/data/workouts";

/**
 * Full-history workouts dual fetcher. Used by /strength which needs every
 * session for PR computation and the volume trend. Returns processed
 * `WorkoutSession[]` (classified exercises, computed volumes).
 *
 * Both variants throw on supabase errors so TanStack Query surfaces isError.
 */

export async function fetchAllWorkoutsServer(
  supabase: SupabaseClient,
  userId: string,
): Promise<WorkoutSession[]> {
  const { data, error } = await supabase
    .from("workouts")
    .select(WORKOUT_QUERY_COLS)
    .eq("user_id", userId)
    .order("date", { ascending: false });
  if (error) throw error;
  return processRawWorkouts((data ?? []) as RawWorkoutRow[]);
}

export async function fetchAllWorkoutsBrowser(userId: string): Promise<WorkoutSession[]> {
  const supabase = createSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("workouts")
    .select(WORKOUT_QUERY_COLS)
    .eq("user_id", userId)
    .order("date", { ascending: false });
  if (error) throw error;
  return processRawWorkouts((data ?? []) as RawWorkoutRow[]);
}
