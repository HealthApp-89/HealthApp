// lib/query/hooks/useDailyLogsTrend.ts
"use client";

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchDailyLogsTrendBrowser } from "@/lib/query/fetchers/dailyLogs";

/**
 * Narrow daily-logs hook for /trends — returns only the 7 columns the
 * sparklines need. Distinct cache key from `useDailyLogs` so the two don't
 * collide (their return shapes differ).
 */
export function useDailyLogsTrend(userId: string, from: string, to: string) {
  return useQuery({
    queryKey: queryKeys.dailyLogs.trend(userId, from, to),
    queryFn: () => fetchDailyLogsTrendBrowser(userId, from, to),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    refetchOnMount: false,
  });
}
