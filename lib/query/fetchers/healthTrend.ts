// lib/query/fetchers/healthTrend.ts
//
// Narrow body-comp projection for /health Trend view + the Today body-comp
// card. Separate from lib/query/fetchers/dailyLogs.ts:fetchDailyLogsTrend to
// avoid widening the /trends payload (which only charts weight/BF% from
// body comp).
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { DailyLog } from "@/lib/data/types";

const COLS =
  "date, weight_kg, body_fat_pct, fat_mass_kg, fat_free_mass_kg, muscle_mass_kg";

export type HealthTrendPoint = Pick<
  DailyLog,
  "date" | "weight_kg" | "body_fat_pct" | "fat_mass_kg" | "fat_free_mass_kg" | "muscle_mass_kg"
>;

export async function fetchHealthTrendServer(
  supabase: SupabaseClient,
  userId: string,
  from: string,
  to: string,
): Promise<HealthTrendPoint[]> {
  const { data, error } = await supabase
    .from("daily_logs")
    .select(COLS)
    .eq("user_id", userId)
    .gte("date", from)
    .lte("date", to)
    .order("date", { ascending: true });
  if (error) throw error;
  return (data ?? []) as HealthTrendPoint[];
}

export async function fetchHealthTrendBrowser(
  userId: string,
  from: string,
  to: string,
): Promise<HealthTrendPoint[]> {
  const supabase = createSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("daily_logs")
    .select(COLS)
    .eq("user_id", userId)
    .gte("date", from)
    .lte("date", to)
    .order("date", { ascending: true });
  if (error) throw error;
  return (data ?? []) as HealthTrendPoint[];
}
