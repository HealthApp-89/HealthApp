// lib/query/fetchers/latestWeight.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export type LatestWeight = { weight_kg: number; date: string } | null;

export async function fetchLatestWeightServer(
  supabase: SupabaseClient,
  userId: string,
  beforeDate: string,
): Promise<LatestWeight> {
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
}

export async function fetchLatestWeightBrowser(
  userId: string,
  beforeDate: string,
): Promise<LatestWeight> {
  const supabase = createSupabaseBrowserClient();
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
}
