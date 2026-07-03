// lib/query/fetchers/latestWeight.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFetcher } from "@/lib/query/fetchers/create-fetcher";

export type LatestWeight = { weight_kg: number; date: string } | null;

const latestWeight = createFetcher(
  async (supabase: SupabaseClient, userId: string, beforeDate: string): Promise<LatestWeight> => {
    const { data, error } = await supabase
      .from("daily_logs")
      .select("weight_kg, date")
      .eq("user_id", userId)
      .lte("date", beforeDate)
      .not("weight_kg", "is", null)
      .order("date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return (data as LatestWeight) ?? null;
  },
);

export const fetchLatestWeightServer = latestWeight.server;
export const fetchLatestWeightBrowser = latestWeight.browser;
