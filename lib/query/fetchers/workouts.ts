// lib/query/fetchers/workouts.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFetcher } from "@/lib/query/fetchers/create-fetcher";

const COLS = `id, date, type, exercises(name, position, exercise_sets(kg, reps, warmup, set_index))`;

export type RawWorkout = {
  id: string;
  date: string;
  type: string | null;
  exercises:
    | {
        name: string;
        position: number | null;
        exercise_sets: { kg: number | null; reps: number | null; warmup: boolean; set_index: number }[];
      }[]
    | null;
};

const workoutsRange = createFetcher(
  async (
    supabase: SupabaseClient,
    userId: string,
    fromDate: string,
    toDate: string,
    limit: number,
  ): Promise<RawWorkout[]> => {
    const { data, error } = await supabase
      .from("workouts")
      .select(COLS)
      .eq("user_id", userId)
      .gte("date", fromDate)
      .lte("date", toDate)
      .order("date", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data ?? []) as RawWorkout[];
  },
);

export const fetchWorkoutsRangeServer = workoutsRange.server;
export const fetchWorkoutsRangeBrowser = workoutsRange.browser;
