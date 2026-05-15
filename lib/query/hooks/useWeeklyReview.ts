"use client";

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchWeeklyReviewBrowser } from "@/lib/query/fetchers/weeklyReview";

export function useWeeklyReview(userId: string, weekStart: string) {
  return useQuery({
    queryKey: queryKeys.weeklyReviews.one(userId, weekStart),
    queryFn: () => fetchWeeklyReviewBrowser(userId, weekStart),
  });
}
