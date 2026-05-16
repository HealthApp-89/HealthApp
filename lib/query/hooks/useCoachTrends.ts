"use client";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import type { CoachTrendsPayload } from "@/lib/data/types";

export function useCoachTrends(userId: string) {
  return useQuery<CoachTrendsPayload>({
    queryKey: queryKeys.coachTrends.one(userId),
    queryFn: async (): Promise<CoachTrendsPayload> => {
      throw new Error("useCoachTrends: expected SSR-hydrated cache hit");
    },
    staleTime: 60 * 1000,
  });
}
