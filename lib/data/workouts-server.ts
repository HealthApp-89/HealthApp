// lib/data/workouts-server.ts
// Server-only thin wrapper around the workouts query. Lives in a separate
// file from `lib/data/workouts.ts` because that module is imported by Client
// Components for pure helpers (buildPRs, buildExerciseTrend, processRawWorkouts);
// pulling `next/headers` (via createSupabaseServerClient) into that import
// graph crashes the client bundle.
//
// Three callers depend on this signature:
//   - app/api/insights/strength/route.ts (service-role context, but uses
//     this for read consistency with the page).
//   - lib/coach/snapshot.ts (coach internals).
//   - The /strength page itself uses `fetchAllWorkoutsServer` from
//     lib/query/fetchers/loadWorkouts.ts instead.

import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  WORKOUT_QUERY_COLS,
  processRawWorkouts,
  type RawWorkoutRow,
  type WorkoutSession,
} from "@/lib/data/workouts";

export async function loadWorkouts(userId: string): Promise<WorkoutSession[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("workouts")
    .select(WORKOUT_QUERY_COLS)
    .eq("user_id", userId)
    .order("date", { ascending: false });

  if (error) throw error;
  return processRawWorkouts((data ?? []) as RawWorkoutRow[]);
}
