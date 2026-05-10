// lib/query/hooks/useAthleteProfileHistory.ts
"use client";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchProfileHistoryBrowser } from "@/lib/query/fetchers/athleteProfile";

/** All non-discarded athlete profile versions, version desc. */
export function useAthleteProfileHistory(userId: string) {
  return useQuery({
    queryKey: queryKeys.athleteProfile.history(userId),
    queryFn: () => fetchProfileHistoryBrowser(userId),
  });
}
