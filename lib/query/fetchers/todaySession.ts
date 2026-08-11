// lib/query/fetchers/todaySession.ts
//
// The committed workout for a single day, with just enough to render the
// done state: duration, exercise count, and `source` (only logger-sourced
// sessions can be modified or unwound).
//
// Deliberately not widened onto lib/query/fetchers/workouts.ts — that one
// backs the dashboard's RecentLiftsCard over a 14-day window, and adding
// columns there would grow every row of that payload for no consumer.
//
// Filtered to `source = 'logger'`. The done state's entire action set
// (Modify, Restart, "Read debrief") is logger-only — SessionDoneBar computes
// `eligible = source === 'logger'` and hides Restart when false, and Modify
// hydrates from the logger draft shape. A non-logger row (a `strong-hk-<date>`
// HealthKit stub from `?source=apple_health`, or a Strong CSV import) can
// support none of that, so it must not suppress the "Start session" CTA
// either — both TodayPlanCard and BriefSessionList gate that CTA on
// `!logged`. Consequence: a day whose only workout arrived via Strong CSV or
// a HealthKit stub renders "Start session", not a done state, even though a
// `workouts` row exists for that date.

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
      .eq("source", "logger")
      // started_at is nullable; NULLs sort first under DESC in Postgres.
      // The source filter above doesn't eliminate multi-row days — two
      // logger sessions can legitimately land on the same date — so this
      // tie-break (newest by started_at wins) is still load-bearing.
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
