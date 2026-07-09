// lib/query/fetchers/strengthInsights.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFetcher } from "@/lib/query/fetchers/create-fetcher";

export type StrengthInsight = { payload: unknown; generated_for_date: string } | null;

/**
 * Latest cached AI insight for /strength. The actual generation happens via
 * /api/insights/strength (server-side, Anthropic call, write-only); this
 * fetcher only reads the cached payload row.
 */

const strengthInsights = createFetcher(
  async (supabase: SupabaseClient, userId: string): Promise<StrengthInsight> => {
    const { data, error } = await supabase
      .from("ai_insights")
      .select("payload, generated_for_date")
      .eq("user_id", userId)
      .eq("kind", "strength")
      .order("generated_for_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return (data as StrengthInsight) ?? null;
  },
);

export const fetchStrengthInsightsServer = strengthInsights.server;
export const fetchStrengthInsightsBrowser = strengthInsights.browser;
