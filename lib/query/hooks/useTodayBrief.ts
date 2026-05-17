// lib/query/hooks/useTodayBrief.ts
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchTodayBriefBrowser } from "@/lib/query/fetchers/todayBrief";

type Options = { enabled?: boolean };

/**
 * Today's morning_brief `ui` payload (MorningBriefCard) for the TodayAnchor.
 * Returns null when the brief hasn't been delivered yet. 60s staleTime so
 * the anchor refreshes after the morning intake state machine transitions
 * `assembling_brief → brief_delivered`.
 *
 * Pass `{ enabled: false }` when the consumer is not currently rendering the
 * Today view, so the query doesn't fire on Recent/Tools tabs.
 */
export function useTodayBrief(
  userId: string,
  today: string,
  options: Options = {},
) {
  return useQuery({
    queryKey: queryKeys.morningBrief.today(userId, today),
    queryFn: () => fetchTodayBriefBrowser(userId, today),
    enabled: options.enabled !== false,
    staleTime: 60_000,
  });
}
