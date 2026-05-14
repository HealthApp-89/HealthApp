// lib/query/hooks/useCoachRecent.ts
import { useQuery } from "@tanstack/react-query";
import { fetchCoachRecentBrowser } from "@/lib/query/fetchers/coachRecent";

/**
 * Newest-first list of days that received a morning brief. Used by the
 * /coach Recent tab. The list changes slowly (one new entry per day) so
 * we use a 5-minute staleTime to avoid refetching on every focus.
 */
export function useCoachRecent(userId: string) {
  return useQuery({
    queryKey: ["coach-recent", userId] as const,
    queryFn: () => fetchCoachRecentBrowser(userId),
    staleTime: 5 * 60_000,
  });
}
