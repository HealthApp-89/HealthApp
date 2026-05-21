// lib/food/aggregate.ts
//
// After a food_log_entries commit, this module:
//   1. Calls sum_food_entries(user_id, date) RPC to total committed items
//   2. Upserts daily_logs nutrition columns for that date
//
// Day-bucketing: the caller passes p_date as the user's local-date string
// (YYYY-MM-DD). The Postgres function compares against (eaten_at at UTC)::date,
// which for single-user-in-CET is usually identical to local date EXCEPT for
// 00:00-01:00 (winter) or 00:00-02:00 (summer) local edge cases. For now we
// accept the UTC bucketing as good-enough; revisit if late-night logging
// shows up wrong (see spec §"Open items").

import type { SupabaseClient } from "@supabase/supabase-js";
import type { FoodMacros } from "@/lib/food/types";
import { ZERO_MACROS } from "@/lib/food/types";

/** Calls sum_food_entries RPC. Returns zeros if no committed entries exist. */
export async function sumFoodEntriesForDate(
  supabase: SupabaseClient,
  userId: string,
  date: string,
): Promise<FoodMacros> {
  const { data, error } = await supabase.rpc("sum_food_entries", {
    p_user_id: userId,
    p_date: date,
  });
  if (error) throw error;
  const row = (data ?? {}) as Partial<FoodMacros>;
  return {
    kcal:      row.kcal      ?? 0,
    protein_g: row.protein_g ?? 0,
    carbs_g:   row.carbs_g   ?? 0,
    fat_g:     row.fat_g     ?? 0,
    fiber_g:   row.fiber_g   ?? 0,
  };
}

/** Upsert daily_logs nutrition columns for (user_id, date) with the given totals.
 *  Other columns on daily_logs are not touched. */
export async function upsertDailyLogsNutrition(
  supabase: SupabaseClient,
  userId: string,
  date: string,
  macros: FoodMacros,
): Promise<void> {
  const { error } = await supabase
    .from("daily_logs")
    .upsert(
      {
        user_id: userId,
        date,
        // daily_logs.calories_eaten is INTEGER (legacy from the Yazio-rounded
        // intake path). sum_food_entries returns decimals from per-100g math
        // (e.g. 912.5 kcal), which Postgres rejects with 22P02 on the upsert
        // and silently 500'd /api/food/commit — see commit history for the
        // symptom ("Confirm shows error but entry shows up after reopening").
        calories_eaten: Math.round(macros.kcal),
        protein_g:      macros.protein_g,
        carbs_g:        macros.carbs_g,
        fat_g:          macros.fat_g,
        fiber_g:        macros.fiber_g,
        source: "food_log",
      },
      { onConflict: "user_id,date" },
    );
  if (error) throw error;
}

/** End-to-end: sum committed entries for the date, upsert daily_logs.
 *  When totals are all zero (last entry deleted), still upserts to clear the
 *  nutrition columns to zero rather than leaving stale aggregates. */
export async function reaggregateDay(
  supabase: SupabaseClient,
  userId: string,
  date: string,
): Promise<FoodMacros> {
  const macros = await sumFoodEntriesForDate(supabase, userId, date);
  await upsertDailyLogsNutrition(supabase, userId, date, macros);
  return macros;
}

/** Re-export for callers that want to short-circuit on no-op. */
export { ZERO_MACROS };
