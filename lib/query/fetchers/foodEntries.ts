// lib/query/fetchers/foodEntries.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { FoodLogEntry } from "@/lib/food/types";

const COLS =
  "id, user_id, eaten_at, meal_slot, kind, raw_input, items, totals, is_estimated, is_favorite, status, created_at, updated_at";

/**
 * Server-side variant — uses the SSR Supabase client (cookie-bound, RLS).
 * Returns committed food_log_entries for [from, to] (inclusive date range).
 */
export async function fetchFoodEntriesServer(
  supabase: SupabaseClient,
  userId: string,
  from: string,
  to: string,
): Promise<FoodLogEntry[]> {
  const { data, error } = await supabase
    .from("food_log_entries")
    .select(COLS)
    .eq("user_id", userId)
    .eq("status", "committed")
    .gte("eaten_at", `${from}T00:00:00Z`)
    .lte("eaten_at", `${to}T23:59:59Z`)
    .order("eaten_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as FoodLogEntry[];
}

/**
 * Browser-side variant — uses the browser Supabase client (cookie-bound, RLS).
 * Returns committed food_log_entries for [from, to] (inclusive date range).
 */
export async function fetchFoodEntriesBrowser(
  userId: string,
  from: string,
  to: string,
): Promise<FoodLogEntry[]> {
  const supabase = createSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("food_log_entries")
    .select(COLS)
    .eq("user_id", userId)
    .eq("status", "committed")
    .gte("eaten_at", `${from}T00:00:00Z`)
    .lte("eaten_at", `${to}T23:59:59Z`)
    .order("eaten_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as FoodLogEntry[];
}
