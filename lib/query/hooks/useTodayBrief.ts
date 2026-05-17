// lib/query/hooks/useTodayBrief.ts
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchTodayBriefBrowser } from "@/lib/query/fetchers/todayBrief";

/**
 * Today's morning_brief `ui` payload (MorningBriefCard) for the TodayAnchor.
 * Returns null when the brief hasn't been delivered yet. 60s staleTime so
 * the anchor refreshes after the morning intake state machine transitions
 * `assembling_brief → brief_delivered`.
 */
export function useTodayBrief(userId: string, today: string) {
  return useQuery({
    queryKey: queryKeys.morningBrief.today(userId, today),
    queryFn: () => fetchTodayBriefBrowser(userId, today),
    staleTime: 60_000,
  });
}
