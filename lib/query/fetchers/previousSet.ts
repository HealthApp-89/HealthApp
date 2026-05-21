// lib/query/fetchers/previousSet.ts
//
// Last completed set for a given (exercise name, set_index) — powers the
// SetRow's "Previous" column (Task 9). Excludes the currently in-progress
// draft workout so the lookup doesn't shadow itself once the user starts
// committing sets.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export type PreviousSet = {
  kg: number | null;
  reps: number | null;
  warmup: boolean;
  workout_date: string;
};

/**
 * Last completed set for this exercise (exact-match by name, case-insensitive
 * trim) at the given set_index, excluding the in-progress draft workout if
 * any.
 *
 * Returns null if no prior workout matches.
 *
 * Uses Supabase's `!inner` relational filter so only workouts with at least
 * one matching exercise + matching set come back. Limit:5 caps the round
 * trip; the loop just picks the first row that materialises.
 */
/**
 * Server variant takes the supabase client as an argument so this file
 * doesn't pull `next/headers` into client bundles. Matches the canonical
 * pattern from `dailyLogs.ts`.
 */
export async function fetchPreviousSetServer(
  supabase: SupabaseClient,
  args: {
    userId: string;
    exerciseName: string;
    setIndex: number;
    excludeWorkoutExternalId: string | null;
  },
): Promise<PreviousSet | null> {
  const trimmed = args.exerciseName.trim();

  let workoutsQ = supabase
    .from("workouts")
    .select(
      "id, date, external_id, exercises!inner(id, name, exercise_sets!inner(set_index, kg, reps, warmup))",
    )
    .eq("user_id", args.userId)
    .ilike("exercises.name", trimmed)
    .eq("exercises.exercise_sets.set_index", args.setIndex)
    .order("date", { ascending: false })
    .limit(5);

  if (args.excludeWorkoutExternalId) {
    workoutsQ = workoutsQ.neq("external_id", args.excludeWorkoutExternalId);
  }

  const { data, error } = await workoutsQ;
  if (error) throw error;

  for (const w of data ?? []) {
    const ex = (
      w.exercises as Array<{
        exercise_sets: Array<{
          set_index: number;
          kg: number | null;
          reps: number | null;
          warmup: boolean;
        }>;
      }>
    )?.[0];
    const set = ex?.exercise_sets?.[0];
    if (set) {
      return {
        kg: set.kg,
        reps: set.reps,
        warmup: set.warmup,
        workout_date: w.date as string,
      };
    }
  }

  return null;
}

export async function fetchPreviousSetBrowser(args: Parameters<typeof fetchPreviousSetServer>[1]) {
  const supabase = createSupabaseBrowserClient();
  return fetchPreviousSetServer(supabase, args);
}
