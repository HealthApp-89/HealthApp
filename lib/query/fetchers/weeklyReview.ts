// lib/query/fetchers/weeklyReview.ts
//
// Server + browser variants. Both throw on Supabase errors so TanStack
// Query's `isError` lights up correctly.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { WeeklyReviewRow } from "@/lib/data/types";
import { createFetcher } from "@/lib/query/fetchers/create-fetcher";

const SELECT_COLUMNS = `
  id, user_id, week_start, next_week_start, version, status, block_id,
  payload, narrative_md, reconfirm_responses,
  committed_at, committed_training_week_id,
  generated_at, updated_at, created_at
`;

const weeklyReview = createFetcher(
  async (supabase: SupabaseClient, userId: string, weekStart: string): Promise<WeeklyReviewRow | null> => {
    const { data, error } = await supabase
      .from("weekly_reviews")
      .select(SELECT_COLUMNS)
      .eq("user_id", userId)
      .eq("week_start", weekStart)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return (data as WeeklyReviewRow | null) ?? null;
  },
);

/** Latest version for (user_id, week_start). Returns null if no row. */
export const fetchWeeklyReviewServer = weeklyReview.server;
export const fetchWeeklyReviewBrowser = weeklyReview.browser;
