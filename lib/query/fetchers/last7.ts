// lib/query/fetchers/last7.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFetcher } from "@/lib/query/fetchers/create-fetcher";

const COLS = "date, hrv, resting_hr, sleep_hours, strain, body_battery_peak, stress_avg";

export type Last7Row = {
  date: string;
  hrv: number | null;
  resting_hr: number | null;
  sleep_hours: number | null;
  strain: number | null;
  body_battery_peak: number | null;
  stress_avg: number | null;
};

const last7 = createFetcher(
  async (supabase: SupabaseClient, userId: string, beforeDate: string, sevenDaysBefore: string): Promise<Last7Row[]> => {
    const { data, error } = await supabase
      .from("daily_logs")
      .select(COLS)
      .eq("user_id", userId)
      .gte("date", sevenDaysBefore)
      .lt("date", beforeDate)
      .order("date", { ascending: false });
    if (error) throw error;
    return (data ?? []) as Last7Row[];
  },
);

export const fetchLast7Server = last7.server;
export const fetchLast7Browser = last7.browser;
