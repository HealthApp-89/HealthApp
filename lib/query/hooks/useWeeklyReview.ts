// lib/query/hooks/useWeeklyReview.ts
"use client";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchWeeklyReviewBrowser } from "@/lib/query/fetchers/weeklyReview";

export function useWeeklyReview(userId: string, weekEnd: string) {
  return useQuery({
    queryKey: queryKeys.insights.weeklyReview(userId, weekEnd),
    queryFn: () => fetchWeeklyReviewBrowser(userId, weekEnd),
    staleTime: 5 * 60_000,
    refetchOnMount: false,
  });
}
