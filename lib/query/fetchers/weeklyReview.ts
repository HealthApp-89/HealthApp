// lib/query/fetchers/weeklyReview.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export type WeeklyReviewRow = { payload: unknown; generated_for_date: string } | null;

/**
 * Cached weekly-review row keyed by `generated_for_date = weekEnd` (Sunday).
 * Generation runs via /api/insights/weekly; this fetcher only reads.
 */

export async function fetchWeeklyReviewServer(
  supabase: SupabaseClient,
  userId: string,
  weekEnd: string,
): Promise<WeeklyReviewRow> {
  const { data, error } = await supabase
    .from("ai_insights")
    .select("payload, generated_for_date")
    .eq("user_id", userId)
    .eq("kind", "weekly_review")
    .eq("generated_for_date", weekEnd)
    .maybeSingle();
  if (error) throw error;
  return (data as WeeklyReviewRow) ?? null;
}

export async function fetchWeeklyReviewBrowser(
  userId: string,
  weekEnd: string,
): Promise<WeeklyReviewRow> {
  const supabase = createSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("ai_insights")
    .select("payload, generated_for_date")
    .eq("user_id", userId)
    .eq("kind", "weekly_review")
    .eq("generated_for_date", weekEnd)
    .maybeSingle();
  if (error) throw error;
  return (data as WeeklyReviewRow) ?? null;
}
