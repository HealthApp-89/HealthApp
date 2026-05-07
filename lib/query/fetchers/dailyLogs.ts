// lib/query/fetchers/dailyLogs.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { DailyLog } from "@/lib/data/types";

const COLS =
  "user_id, date, hrv, resting_hr, recovery, spo2, skin_temp_c, strain, sleep_hours, sleep_score, deep_sleep_hours, rem_sleep_hours, weight_kg, body_fat_pct, steps, calories, calories_eaten, protein_g, carbs_g, fat_g, respiratory_rate, notes, source, updated_at";

/** Server-side variant — uses the SSR Supabase client (cookie-bound, RLS). */
export async function fetchDailyLogsServer(
  supabase: SupabaseClient,
  userId: string,
  from: string,
  to: string,
): Promise<DailyLog[]> {
  const { data } = await supabase
    .from("daily_logs")
    .select(COLS)
    .eq("user_id", userId)
    .gte("date", from)
    .lte("date", to)
    .order("date", { ascending: true });
  return (data ?? []) as DailyLog[];
}

/** Browser-side variant — uses the browser Supabase client (cookie-bound, RLS). */
export async function fetchDailyLogsBrowser(
  userId: string,
  from: string,
  to: string,
): Promise<DailyLog[]> {
  const supabase = createSupabaseBrowserClient();
  const { data } = await supabase
    .from("daily_logs")
    .select(COLS)
    .eq("user_id", userId)
    .gte("date", from)
    .lte("date", to)
    .order("date", { ascending: true });
  return (data ?? []) as DailyLog[];
}
