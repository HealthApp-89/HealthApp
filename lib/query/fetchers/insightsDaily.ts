// lib/query/fetchers/insightsDaily.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export type DailyInsightRow = { payload: unknown; generated_for_date: string } | null;

/**
 * Latest cached daily-insight row for /coach (today view). Generation runs via
 * /api/insights (Anthropic call); this fetcher only reads the cached payload.
 */

export async function fetchInsightsDailyServer(
  supabase: SupabaseClient,
  userId: string,
): Promise<DailyInsightRow> {
  const { data, error } = await supabase
    .from("ai_insights")
    .select("payload, generated_for_date")
    .eq("user_id", userId)
    .eq("kind", "coach")
    .order("generated_for_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as DailyInsightRow) ?? null;
}

export async function fetchInsightsDailyBrowser(userId: string): Promise<DailyInsightRow> {
  const supabase = createSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("ai_insights")
    .select("payload, generated_for_date")
    .eq("user_id", userId)
    .eq("kind", "coach")
    .order("generated_for_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as DailyInsightRow) ?? null;
}
