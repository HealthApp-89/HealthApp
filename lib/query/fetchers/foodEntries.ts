// lib/query/fetchers/foodEntries.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FoodLogEntry } from "@/lib/food/types";
import { createFetcher } from "@/lib/query/fetchers/create-fetcher";
import { localDayRangeUtc } from "@/lib/time";

const COLS =
  "id, user_id, eaten_at, meal_slot, kind, raw_input, items, totals, is_estimated, is_favorite, status, created_at, updated_at";

const foodEntries = createFetcher(
  async (
    supabase: SupabaseClient,
    userId: string,
    from: string,
    to: string,
    timeZone: string,
  ): Promise<FoodLogEntry[]> => {
    // `from`/`to` are calendar days in the athlete's timezone; translate them
    // into the half-open UTC instant range that actually covers those days.
    // Bounding on `${from}T00:00:00Z` instead pushed every entry logged
    // between local midnight and the UTC offset onto the previous day.
    const { startUtc } = localDayRangeUtc(from, timeZone);
    const { endUtc } = localDayRangeUtc(to, timeZone);
    const { data, error } = await supabase
      .from("food_log_entries")
      .select(COLS)
      .eq("user_id", userId)
      .eq("status", "committed")
      .gte("eaten_at", startUtc)
      .lt("eaten_at", endUtc)
      .order("eaten_at", { ascending: false });
    if (error) throw error;
    return (data ?? []) as FoodLogEntry[];
  },
);

/**
 * Server-side variant — uses the SSR Supabase client (cookie-bound, RLS).
 * Returns committed food_log_entries for [from, to] (inclusive date range),
 * where both bounds are calendar days in `timeZone` (profiles.timezone).
 */
export const fetchFoodEntriesServer = foodEntries.server;

/**
 * Browser-side variant — uses the browser Supabase client (cookie-bound, RLS).
 * Returns committed food_log_entries for [from, to] (inclusive date range),
 * where both bounds are calendar days in `timeZone` (profiles.timezone).
 */
export const fetchFoodEntriesBrowser = foodEntries.browser;
