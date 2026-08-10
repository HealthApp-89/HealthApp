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
import { normalizeExerciseName } from "@/lib/coach/exercise-muscles";
import { createFetcher } from "@/lib/query/fetchers/create-fetcher";

export type PreviousSet = {
  kg: number | null;
  reps: number | null;
  workout_date: string;
  /** True when the requested ordinal exceeded the prior session's working-set
   *  count and we returned that session's last working set instead. */
  fallback: boolean;
};

/** One workout row as the query below returns it. Exported so the pure
 *  selector can be unit-tested without a Supabase client. */
export type PreviousSetWorkoutRow = {
  date: string;
  exercises:
    | Array<{
        name: string;
        /** Ordering of this exercise within the workout. Load-bearing: one
         *  exercise can occupy several rows (see selectPreviousWorkingSet). */
        position?: number | null;
        exercise_sets: Array<{
          set_index: number;
          kg: number | null;
          reps: number | null;
          warmup: boolean;
        }> | null;
      }>
    | null;
};

/**
 * Pick the prior working set at `workingSetOrdinal` for `normalizedTarget`,
 * scanning `workouts` newest-first.
 *
 * The subtlety this function exists for: ONE exercise can be stored as
 * SEVERAL `exercises` rows sharing the same name. `augmentWarmups` in
 * prescribe-week.ts emits each warmup as its own `PlannedExercise`, so a
 * squat day persists three rows all called "Squat (Barbell)" — two
 * warmup-only, then the working row.
 *
 * The original implementation used `.find()`, matched the FIRST such row (a
 * warmup), saw no working sets in it, and skipped the whole workout — then
 * repeated that for every session since warmups shipped, eventually
 * surfacing a pre-warmup workout months old. The athlete squatted 80 × 7 × 3
 * and the logger showed 65 × 10 from ten weeks earlier.
 *
 * So: gather the sets from EVERY row whose normalized name matches, ordered
 * by (position, set_index), and only then drop warmups and index by ordinal.
 */
export function selectPreviousWorkingSet(
  workouts: readonly PreviousSetWorkoutRow[],
  normalizedTarget: string,
  workingSetOrdinal: number,
): PreviousSet | null {
  for (const w of workouts) {
    const matching = (w.exercises ?? []).filter(
      (e) => normalizeExerciseName(e.name) === normalizedTarget,
    );
    if (matching.length === 0) continue;

    const workingSets = matching
      .flatMap((e, rowIdx) =>
        (e.exercise_sets ?? []).map((s) => ({
          ...s,
          // Fall back to the array order when position is absent, so rows
          // never collapse onto a single sort key.
          rowOrder: e.position ?? rowIdx,
        })),
      )
      .filter((s) => !s.warmup)
      .sort((a, b) => a.rowOrder - b.rowOrder || a.set_index - b.set_index);

    if (workingSets.length === 0) continue;

    const exact = workingSets[workingSetOrdinal - 1];
    if (exact) {
      return { kg: exact.kg, reps: exact.reps, workout_date: w.date, fallback: false };
    }

    // Set-count overrun — today's ordinal is past the end of that session's
    // working-set list. Return its last working set as a "here's your prior
    // heavy effort" anchor, flagged so the UI can mark it.
    const last = workingSets[workingSets.length - 1];
    return { kg: last.kg, reps: last.reps, workout_date: w.date, fallback: true };
  }

  return null;
}

type PreviousSetArgs = {
  userId: string;
  exerciseName: string;
  /** 1-indexed position among non-warmup sets for the current row. */
  workingSetOrdinal: number;
  excludeWorkoutExternalId: string | null;
};

const previousSetFetcher = createFetcher(
  async (supabase: SupabaseClient, args: PreviousSetArgs): Promise<PreviousSet | null> => {
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
        "id, date, external_id, exercises!inner(id, name, position, exercise_sets(set_index, kg, reps, warmup))",
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

    // Selection lives in a pure, unit-tested helper — the exact normalized
    // match (which rejects the loose ILIKE's substring false-positives) and
    // the multi-row gathering both happen there.
    return selectPreviousWorkingSet(
      (data ?? []) as unknown as PreviousSetWorkoutRow[],
      normalizedTarget,
      args.workingSetOrdinal,
    );
  },
);

export const fetchPreviousSetServer = previousSetFetcher.server;
export const fetchPreviousSetBrowser = previousSetFetcher.browser;
