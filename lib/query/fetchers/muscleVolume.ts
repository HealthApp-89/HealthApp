// lib/query/fetchers/muscleVolume.ts
//
// Two variants (server + browser) sharing the same select string and the
// `buildSnapshot` pure-assembly helper. RLS enforces per-user scoping
// at both layers. The morning-brief route handler (PR 5) will also use
// the server variant directly (bypassing the client cache — it runs in
// a route handler).

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  computeWeeklyMuscleVolume,
  type Workout,
} from "@/lib/coach/muscle-volume";
import {
  EXERCISE_MUSCLES,
  normalizeExerciseName,
  TARGET_GROUP_FOR_MUSCLE,
} from "@/lib/coach/exercise-muscles";
import { TARGETED_MUSCLE_GROUPS } from "@/lib/data/types";
import type {
  MuscleVolumeSnapshot,
  TargetedMuscleGroup,
} from "@/lib/data/types";
import { createFetcher } from "@/lib/query/fetchers/create-fetcher";

const SELECT = "date, exercises (name, sets:exercise_sets (kg, reps, warmup))";

const muscleVolume = createFetcher(
  async (supabase: SupabaseClient, userId: string, today: string): Promise<MuscleVolumeSnapshot> => {
    const since = isoMinusDays(today, 56);
    const { data, error } = await supabase
      .from("workouts")
      .select(SELECT)
      .eq("user_id", userId)
      .gte("date", since)
      .order("date", { ascending: true });
    if (error) throw error;
    return buildSnapshot(data ?? [], today);
  },
);

/** Server-side fetcher used by Server Components via makeServerQueryClient,
 *  and by the morning-brief route handler (PR 5). */
export const fetchMuscleVolumeServer = muscleVolume.server;

/** Browser fetcher used by useMuscleVolume hook.
 *  Per project pattern in lib/query/fetchers/workouts.ts: browser fetcher
 *  constructs its own SupabaseClient and does NOT take one as an argument. */
export const fetchMuscleVolumeBrowser = muscleVolume.browser;

/** Pure assembly: convert raw rows → snapshot. Exported for tests / scripts. */
export function buildSnapshot(
  rawWorkouts: Array<{ date: string; exercises: unknown }>,
  today: string,
): MuscleVolumeSnapshot {
  const workouts: Workout[] = rawWorkouts.map((w) => ({
    date: w.date,
    exercises: (
      (
        w.exercises as Array<{
          name: string;
          sets: Array<{ kg: number | null; reps: number | null; warmup: boolean }>;
        }>
      ) ?? []
    ).map((e) => ({
      name: e.name,
      sets: (e.sets ?? []).map((s) => ({
        kg: s.kg,
        reps: s.reps,
        warmup: s.warmup,
      })),
    })),
  }));

  const weekStart = previousSunday(today);

  const { volumes: rolling_avg_8wk } = computeWeeklyMuscleVolume(workouts, 56);

  const currentWeekWorkouts = workouts.filter((w) => w.date >= weekStart);
  const { volumes: current_week_to_date } = computeWeeklyMuscleVolume(
    currentWeekWorkouts,
    7,
  );

  const weekly_history: MuscleVolumeSnapshot["weekly_history"] = [];
  for (let i = 8; i >= 1; i--) {
    const ws = isoMinusDays(weekStart, (i - 1) * 7);
    const wsEnd = isoPlusDays(ws, 7);
    const inWeek = workouts.filter((w) => w.date >= ws && w.date < wsEnd);
    const { volumes } = computeWeeklyMuscleVolume(inWeek, 7);
    weekly_history.push({ week_start: ws, volumes });
  }

  // Top exercises per targeted muscle (over the full 8wk window)
  const setsByMuscleByExercise = new Map<
    TargetedMuscleGroup,
    Map<string, number>
  >();
  for (const g of TARGETED_MUSCLE_GROUPS) {
    setsByMuscleByExercise.set(g, new Map());
  }

  for (const w of workouts) {
    for (const ex of w.exercises) {
      const mapping = EXERCISE_MUSCLES[normalizeExerciseName(ex.name)];
      if (!mapping) continue;
      const setCount = ex.sets.filter(
        (s) => !s.warmup && s.reps != null && s.reps > 0,
      ).length;
      if (setCount === 0) continue;
      for (const mid of mapping.primary) {
        const g = TARGET_GROUP_FOR_MUSCLE[mid];
        if (!g) continue;
        const map = setsByMuscleByExercise.get(g)!;
        map.set(ex.name, (map.get(ex.name) ?? 0) + setCount);
      }
      for (const mid of mapping.secondary) {
        const g = TARGET_GROUP_FOR_MUSCLE[mid];
        if (!g) continue;
        const map = setsByMuscleByExercise.get(g)!;
        map.set(ex.name, (map.get(ex.name) ?? 0) + setCount * 0.5);
      }
    }
  }

  const top_exercises_per_muscle = Object.fromEntries(
    TARGETED_MUSCLE_GROUPS.map((g) => {
      const sorted = Array.from(setsByMuscleByExercise.get(g)!.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([name, sets]) => ({ name, sets: Math.round(sets * 10) / 10 }));
      return [g, sorted];
    }),
  ) as MuscleVolumeSnapshot["top_exercises_per_muscle"];

  return {
    computed_at: new Date().toISOString(),
    rolling_avg_8wk,
    current_week_to_date,
    weekly_history,
    top_exercises_per_muscle,
  };
}

// ── ISO date helpers ────────────────────────────────────────────────────────

function isoMinusDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function isoPlusDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Returns the Sunday ON OR BEFORE the given ISO date. Sunday = day 0. */
function previousSunday(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  const dow = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}
