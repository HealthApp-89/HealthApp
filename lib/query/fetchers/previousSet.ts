// lib/query/fetchers/previousSet.ts
//
// Last completed working-set for a given (exercise name, working-set ordinal)
// — powers the SetRow's "Previous" column. Excludes the in-progress draft so
// the lookup doesn't shadow itself once the user starts committing sets.
//
// Matched by *working-set ordinal*, not raw DB `set_index`. Two sessions with
// different warmup counts (e.g. 0 warmups last week, 2 today) still align
// correctly: today's "working set 1" compares against last week's "working
// set 1", regardless of where those rows sit in `set_index` space. Warmup
// rows from history are never surfaced as a "previous" value — they're
// filtered out before ordinal counting.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export type PreviousSet = {
  kg: number | null;
  reps: number | null;
  workout_date: string;
};

export async function fetchPreviousSetServer(
  supabase: SupabaseClient,
  args: {
    userId: string;
    exerciseName: string;
    /** 1-indexed position among non-warmup sets for the current row. */
    workingSetOrdinal: number;
    excludeWorkoutExternalId: string | null;
  },
): Promise<PreviousSet | null> {
  const trimmed = args.exerciseName.trim();
  if (!trimmed || args.workingSetOrdinal < 1) return null;

  // Pull the candidate workout's full set list for this exercise; ordinal
  // selection happens in JS so warmup-count drift across sessions can't
  // misalign the comparison.
  let workoutsQ = supabase
    .from("workouts")
    .select(
      "id, date, external_id, exercises!inner(id, name, exercise_sets(set_index, kg, reps, warmup))",
    )
    .eq("user_id", args.userId)
    .ilike("exercises.name", trimmed)
    .order("date", { ascending: false })
    .limit(10);

  if (args.excludeWorkoutExternalId) {
    workoutsQ = workoutsQ.neq("external_id", args.excludeWorkoutExternalId);
  }

  const { data, error } = await workoutsQ;
  if (error) throw error;

  for (const w of data ?? []) {
    const exercises = w.exercises as Array<{
      exercise_sets: Array<{
        set_index: number;
        kg: number | null;
        reps: number | null;
        warmup: boolean;
      }>;
    }>;
    const ex = exercises?.[0];
    if (!ex?.exercise_sets?.length) continue;

    const workingSets = [...ex.exercise_sets]
      .sort((a, b) => a.set_index - b.set_index)
      .filter((s) => !s.warmup);

    const match = workingSets[args.workingSetOrdinal - 1];
    if (match) {
      return {
        kg: match.kg,
        reps: match.reps,
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
