// lib/query/hooks/useStrengthInsights.ts
"use client";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchStrengthInsightsBrowser } from "@/lib/query/fetchers/strengthInsights";

export function useStrengthInsights(userId: string) {
  return useQuery({
    queryKey: queryKeys.insights.strength(userId),
    queryFn: () => fetchStrengthInsightsBrowser(userId),
    staleTime: 5 * 60_000,
    refetchOnMount: false,
  });
}
