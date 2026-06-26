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
//
// Exercise name match is normalized (lowercase, strip equipment parens,
// collapse whitespace) so renames like "Bench Press" → "Bench Press (Barbell)"
// still resolve to the same lift history.
//
// If today's ordinal exceeds the prior session's working-set count (e.g.
// you're doing a 5th working set when last week only had 4), the fetcher
// falls back to that session's LAST working set and flags `fallback: true`
// so the UI can render a marker.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { normalizeExerciseName } from "@/lib/coach/exercise-muscles";

export type PreviousSet = {
  kg: number | null;
  reps: number | null;
  workout_date: string;
  /** True when the requested ordinal exceeded the prior session's working-set
   *  count and we returned that session's last working set instead. */
  fallback: boolean;
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

  const normalizedTarget = normalizeExerciseName(trimmed);
  if (!normalizedTarget) return null;

  // Loose server-side filter via substring ILIKE — catches "Bench Press"
  // and "Bench Press (Barbell)" alike. The exact normalized-name comparison
  // happens in JS below so substring false-positives ("Squat" vs "Front
  // Squat") get rejected.
  let workoutsQ = supabase
    .from("workouts")
    .select(
      "id, date, external_id, exercises!inner(id, name, exercise_sets(set_index, kg, reps, warmup))",
    )
    .eq("user_id", args.userId)
    .ilike("exercises.name", `%${normalizedTarget}%`)
    .order("date", { ascending: false })
    .limit(10);

  if (args.excludeWorkoutExternalId) {
    workoutsQ = workoutsQ.neq("external_id", args.excludeWorkoutExternalId);
  }

  const { data, error } = await workoutsQ;
  if (error) throw error;

  for (const w of data ?? []) {
    const exercises = w.exercises as Array<{
      name: string;
      exercise_sets: Array<{
        set_index: number;
        kg: number | null;
        reps: number | null;
        warmup: boolean;
      }>;
    }>;

    // Exact normalized match — guards against the loose ILIKE catching
    // unrelated lifts that happen to share a substring.
    const ex = exercises?.find((e) => normalizeExerciseName(e.name) === normalizedTarget);
    if (!ex?.exercise_sets?.length) continue;

    const workingSets = [...ex.exercise_sets]
      .sort((a, b) => a.set_index - b.set_index)
      .filter((s) => !s.warmup);

    if (workingSets.length === 0) continue;

    const exact = workingSets[args.workingSetOrdinal - 1];
    if (exact) {
      return {
        kg: exact.kg,
        reps: exact.reps,
        workout_date: w.date as string,
        fallback: false,
      };
    }

    // Set-count overrun — today's ordinal is past the end of last session's
    // working-set list. Return the last available working set as a "here's
    // your prior heavy effort" anchor, flagged so the UI can mark it.
    const last = workingSets[workingSets.length - 1];
    return {
      kg: last.kg,
      reps: last.reps,
      workout_date: w.date as string,
      fallback: true,
    };
  }

  return null;
}

export async function fetchPreviousSetBrowser(args: Parameters<typeof fetchPreviousSetServer>[1]) {
  const supabase = createSupabaseBrowserClient();
  return fetchPreviousSetServer(supabase, args);
}
