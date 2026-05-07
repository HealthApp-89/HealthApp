// lib/query/hooks/useLatestWeight.ts
"use client";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchLatestWeightBrowser } from "@/lib/query/fetchers/latestWeight";

export function useLatestWeight(userId: string, beforeDate: string) {
  return useQuery({
    queryKey: queryKeys.dailyLogs.latestWeight(userId, beforeDate),
    queryFn: () => fetchLatestWeightBrowser(userId, beforeDate),
    staleTime: 5 * 60_000,
    refetchOnMount: false,
  });
}
