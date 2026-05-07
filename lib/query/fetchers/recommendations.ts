// lib/query/fetchers/recommendations.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

const COLS = "id, week_start, text, category, priority, position, done";

export type RawRecommendation = {
  id: string;
  week_start: string;
  text: string;
  category: string | null;
  priority: number | null;
  position: number;
  done: boolean;
};

export type RecommendationsResult = {
  /** The week the rows came from (target week, or fallback latest week). */
  weekShown: string | null;
  items: RawRecommendation[];
};

/**
 * Recommendations for /coach (next-week view). Tries the target upcoming
 * week first; on empty result, falls back to the most recent week that has
 * any rows. Two queries — keep them server-side or browser-side as a unit
 * so the cache key is the *requested* `targetWeek`, but the result reflects
 * whichever week actually had data.
 */

export async function fetchRecommendationsServer(
  supabase: SupabaseClient,
  userId: string,
  targetWeek: string,
): Promise<RecommendationsResult> {
  const primary = await supabase
    .from("coach_recommendations")
    .select(COLS)
    .eq("user_id", userId)
    .eq("week_start", targetWeek)
    .order("position", { ascending: true });
  if (primary.error) throw primary.error;
  if (primary.data && primary.data.length) {
    return { weekShown: targetWeek, items: primary.data as RawRecommendation[] };
  }

  // Fallback — newest week with any rows.
  const fallback = await supabase
    .from("coach_recommendations")
    .select(COLS)
    .eq("user_id", userId)
    .order("week_start", { ascending: false })
    .order("position", { ascending: true })
    .limit(20);
  if (fallback.error) throw fallback.error;
  const all = (fallback.data ?? []) as RawRecommendation[];
  const weekShown = all[0]?.week_start ?? null;
  const items = all.filter((r) => r.week_start === weekShown);
  return { weekShown, items };
}

export async function fetchRecommendationsBrowser(
  userId: string,
  targetWeek: string,
): Promise<RecommendationsResult> {
  const supabase = createSupabaseBrowserClient();
  const primary = await supabase
    .from("coach_recommendations")
    .select(COLS)
    .eq("user_id", userId)
    .eq("week_start", targetWeek)
    .order("position", { ascending: true });
  if (primary.error) throw primary.error;
  if (primary.data && primary.data.length) {
    return { weekShown: targetWeek, items: primary.data as RawRecommendation[] };
  }

  const fallback = await supabase
    .from("coach_recommendations")
    .select(COLS)
    .eq("user_id", userId)
    .order("week_start", { ascending: false })
    .order("position", { ascending: true })
    .limit(20);
  if (fallback.error) throw fallback.error;
  const all = (fallback.data ?? []) as RawRecommendation[];
  const weekShown = all[0]?.week_start ?? null;
  const items = all.filter((r) => r.week_start === weekShown);
  return { weekShown, items };
}
