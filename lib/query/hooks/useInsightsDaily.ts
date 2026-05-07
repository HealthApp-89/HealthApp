// lib/query/hooks/useInsightsDaily.ts
"use client";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchInsightsDailyBrowser } from "@/lib/query/fetchers/insightsDaily";

export function useInsightsDaily(userId: string, todayDate: string) {
  return useQuery({
    queryKey: queryKeys.insights.daily(userId, todayDate),
    queryFn: () => fetchInsightsDailyBrowser(userId),
    staleTime: 5 * 60_000,
    refetchOnMount: false,
  });
}
