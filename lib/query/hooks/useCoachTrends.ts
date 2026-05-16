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
    // SSR-hydrate-only — no browser refetch path (queryFn throws by design).
    // Stale-after-60s would trigger background refetch → blank page; Infinity
    // keeps the dehydrated payload authoritative for the page lifetime.
    staleTime: Infinity,
  });
}
