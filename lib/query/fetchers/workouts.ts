// lib/query/fetchers/workouts.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

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

export async function fetchWorkoutsRangeServer(
  supabase: SupabaseClient,
  userId: string,
  fromDate: string,
  toDate: string,
  limit = 5,
): Promise<RawWorkout[]> {
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
}

export async function fetchWorkoutsRangeBrowser(
  userId: string,
  fromDate: string,
  toDate: string,
  limit = 5,
): Promise<RawWorkout[]> {
  const supabase = createSupabaseBrowserClient();
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
}
