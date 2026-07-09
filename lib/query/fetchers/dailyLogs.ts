// lib/query/fetchers/dailyLogs.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DailyLog } from "@/lib/data/types";
import { createFetcher } from "@/lib/query/fetchers/create-fetcher";

// Wide projection — every column on `DailyLog` (lib/data/types.ts). When you
// add a column to the type, add it here too: a missing column makes the field
// silently absent from the returned row, which shows up in the UI as a
// permanently-empty input even when the sync writer is populating the DB
// correctly. Trends has its own narrower projection (TREND_COLS below) for
// payload size; everywhere else expects the full shape.
const COLS =
  "user_id, date, hrv, resting_hr, recovery, spo2, skin_temp_c, strain, sleep_hours, sleep_score, deep_sleep_hours, rem_sleep_hours, weight_kg, body_fat_pct, fat_mass_kg, fat_free_mass_kg, muscle_mass_kg, bone_mass_kg, hydration_kg, steps, calories, active_calories, distance_km, exercise_min, calories_eaten, protein_g, carbs_g, fat_g, fiber_g, respiratory_rate, notes, source, updated_at, body_battery_low, body_battery_peak, stress_avg, stress_max, stress_qualifier";

/**
 * Server variant takes the supabase client as an argument so the caller (a
 * Server Component) controls cookie/auth scoping. The browser variant
 * self-constructs because the browser client is stateless and cookie-bound
 * via the document, not via call-site state.
 *
 * Both throw on Supabase errors rather than silently returning [] — the
 * empty-array fallback is reserved for "RLS returned 0 rows", which is
 * legitimate. Errors must surface so TanStack Query lights up `isError` and
 * the UI can show a real error state.
 */

const dailyLogs = createFetcher(
  async (supabase: SupabaseClient, userId: string, from: string, to: string): Promise<DailyLog[]> => {
    const { data, error } = await supabase
      .from("daily_logs")
      .select(COLS)
      .eq("user_id", userId)
      .gte("date", from)
      .lte("date", to)
      .order("date", { ascending: true });
    if (error) throw error;
    return (data ?? []) as DailyLog[];
  },
);

/** Server-side variant — uses the SSR Supabase client (cookie-bound, RLS). */
export const fetchDailyLogsServer = dailyLogs.server;
/** Browser-side variant — uses the browser Supabase client (cookie-bound, RLS). */
export const fetchDailyLogsBrowser = dailyLogs.browser;

/**
 * Narrow projection for /trends — only the 6 charted metrics + date. About
 * a 70% payload reduction vs the wide COLS above, which matters because
 * /trends prefetches ~16 months of rows. Separate cache key (queryKeys
 * .dailyLogs.trend) so it doesn't collide with `range` consumers that
 * expect the full DailyLog shape.
 */
const TREND_COLS = "date, hrv, resting_hr, sleep_hours, strain, weight_kg, body_fat_pct, body_battery_peak, stress_avg";

export type TrendLog = Pick<
  DailyLog,
  "date" | "hrv" | "resting_hr" | "sleep_hours" | "strain" | "weight_kg" | "body_fat_pct" | "body_battery_peak" | "stress_avg"
>;

const dailyLogsTrend = createFetcher(
  async (supabase: SupabaseClient, userId: string, from: string, to: string): Promise<TrendLog[]> => {
    const { data, error } = await supabase
      .from("daily_logs")
      .select(TREND_COLS)
      .eq("user_id", userId)
      .gte("date", from)
      .lte("date", to)
      .order("date", { ascending: true });
    if (error) throw error;
    return (data ?? []) as TrendLog[];
  },
);

export const fetchDailyLogsTrendServer = dailyLogsTrend.server;
export const fetchDailyLogsTrendBrowser = dailyLogsTrend.browser;
