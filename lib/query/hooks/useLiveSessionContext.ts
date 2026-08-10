// lib/query/hooks/useLiveSessionContext.ts
"use client";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchLiveSessionContextBrowser } from "@/lib/query/fetchers/liveSessionContext";

/**
 * Fetched ONCE when the logger opens and then held. staleTime is Infinity on
 * purpose: the only thing that changes during a session is the athlete's own
 * sets, which the rules read from the draft rather than from this snapshot.
 */
export function useLiveSessionContext(
  userId: string,
  date: string,
  exerciseNames: string[],
) {
  return useQuery({
    queryKey: queryKeys.liveSessionContext.one(userId, date, exerciseNames),
    queryFn: () =>
      fetchLiveSessionContextBrowser({ userId, today: date, exerciseNames }),
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    enabled: exerciseNames.length > 0,
  });
}
