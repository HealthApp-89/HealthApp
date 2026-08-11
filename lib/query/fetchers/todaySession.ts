// lib/query/fetchers/todaySession.ts
//
// The committed workout for a single day, with just enough to render the
// done state: duration, exercise count, and `source` (only logger-sourced
// sessions can be modified or unwound).
//
// Deliberately not widened onto lib/query/fetchers/workouts.ts — that one
// backs the dashboard's RecentLiftsCard over a 14-day window, and adding
// columns there would grow every row of that payload for no consumer.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createFetcher } from "@/lib/query/fetchers/create-fetcher";

export type TodaySessionWorkout = {
  id: string;
  type: string | null;
  duration_min: number | null;
  source: string | null;
  exercise_count: number;
};

const todaySession = createFetcher(
  async (
    supabase: SupabaseClient,
    userId: string,
    date: string,
  ): Promise<TodaySessionWorkout | null> => {
    const { data, error } = await supabase
      .from("workouts")
      .select("id, type, duration_min, source, exercises(id)")
      .eq("user_id", userId)
      .eq("date", date)
      // started_at is nullable; NULLs sort first under DESC in Postgres.
      .order("started_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const row = data as unknown as {
      id: string;
      type: string | null;
      duration_min: number | null;
      source: string | null;
      exercises: { id: string }[] | null;
    };
    return {
      id: row.id,
      type: row.type,
      duration_min: row.duration_min,
      source: row.source,
      exercise_count: row.exercises?.length ?? 0,
    };
  },
);

export const fetchTodaySessionServer = todaySession.server;
export const fetchTodaySessionBrowser = todaySession.browser;
