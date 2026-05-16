import type { SupabaseClient } from "@supabase/supabase-js";
import { generateCoachTrends } from "@/lib/coach/trends";
import type { CoachTrendsPayload } from "@/lib/data/types";

export async function fetchCoachTrendsServer(
  supabase: SupabaseClient,
  userId: string,
  today: string,
): Promise<CoachTrendsPayload> {
  return generateCoachTrends({ supabase, userId, today });
}

export async function fetchCoachTrendsBrowser(
  userId: string,
  today: string,
): Promise<CoachTrendsPayload> {
  // The page is SSR-rendered and hydrated; the browser fetcher throws by design.
  // The hook reads cached data only; if a runtime refetch is needed later, add a
  // /api/coach/trends route.
  void userId; void today;
  throw new Error("coachTrends browser fetcher: not implemented — use SSR hydrate only.");
}
