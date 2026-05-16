"use client";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";

export function useCoachTrends(userId: string) {
  return useQuery({
    queryKey: queryKeys.coachTrends.one(userId),
    queryFn: async () => {
      throw new Error("useCoachTrends: expected SSR-hydrated cache hit");
    },
    staleTime: 60 * 1000,
  });
}
