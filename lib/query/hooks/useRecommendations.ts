// lib/query/hooks/useRecommendations.ts
"use client";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchRecommendationsBrowser } from "@/lib/query/fetchers/recommendations";

export function useRecommendations(userId: string, targetWeek: string) {
  return useQuery({
    queryKey: queryKeys.recommendations.week(userId, targetWeek),
    queryFn: () => fetchRecommendationsBrowser(userId, targetWeek),
    staleTime: 5 * 60_000,
    refetchOnMount: false,
  });
}
