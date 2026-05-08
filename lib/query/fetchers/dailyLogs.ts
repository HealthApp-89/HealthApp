// lib/query/fetchers/dailyLogs.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { DailyLog } from "@/lib/data/types";

const COLS =
  "user_id, date, hrv, resting_hr, recovery, spo2, skin_temp_c, strain, sleep_hours, sleep_score, deep_sleep_hours, rem_sleep_hours, weight_kg, body_fat_pct, steps, calories, calories_eaten, protein_g, carbs_g, fat_g, respiratory_rate, notes, source, updated_at";

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

/** Server-side variant — uses the SSR Supabase client (cookie-bound, RLS). */
export async function fetchDailyLogsServer(
  supabase: SupabaseClient,
  userId: string,
  from: string,
  to: string,
): Promise<DailyLog[]> {
  const { data, error } = await supabase
    .from("daily_logs")
    .select(COLS)
    .eq("user_id", userId)
    .gte("date", from)
    .lte("date", to)
    .order("date", { ascending: true });
  if (error) throw error;
  return (data ?? []) as DailyLog[];
}

/** Browser-side variant — uses the browser Supabase client (cookie-bound, RLS). */
export async function fetchDailyLogsBrowser(
  userId: string,
  from: string,
  to: string,
): Promise<DailyLog[]> {
  const supabase = createSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("daily_logs")
    .select(COLS)
    .eq("user_id", userId)
    .gte("date", from)
    .lte("date", to)
    .order("date", { ascending: true });
  if (error) throw error;
  return (data ?? []) as DailyLog[];
}

/**
 * Narrow projection for /trends — only the 6 charted metrics + date. About
 * a 70% payload reduction vs the wide COLS above, which matters because
 * /trends prefetches ~16 months of rows. Separate cache key (queryKeys
 * .dailyLogs.trend) so it doesn't collide with `range` consumers that
 * expect the full DailyLog shape.
 */
const TREND_COLS = "date, hrv, resting_hr, sleep_hours, strain, weight_kg, body_fat_pct";

export type TrendLog = Pick<
  DailyLog,
  "date" | "hrv" | "resting_hr" | "sleep_hours" | "strain" | "weight_kg" | "body_fat_pct"
>;

export async function fetchDailyLogsTrendServer(
  supabase: SupabaseClient,
  userId: string,
  from: string,
  to: string,
): Promise<TrendLog[]> {
  const { data, error } = await supabase
    .from("daily_logs")
    .select(TREND_COLS)
    .eq("user_id", userId)
    .gte("date", from)
    .lte("date", to)
    .order("date", { ascending: true });
  if (error) throw error;
  return (data ?? []) as TrendLog[];
}

export async function fetchDailyLogsTrendBrowser(
  userId: string,
  from: string,
  to: string,
): Promise<TrendLog[]> {
  const supabase = createSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("daily_logs")
    .select(TREND_COLS)
    .eq("user_id", userId)
    .gte("date", from)
    .lte("date", to)
    .order("date", { ascending: true });
  if (error) throw error;
  return (data ?? []) as TrendLog[];
}
