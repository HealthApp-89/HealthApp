"use client";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchRecoveryIntelligenceBrowser } from "@/lib/query/fetchers/recoveryIntelligence";
import type { RecoveryIntelligencePayload } from "@/lib/coach/recovery-intelligence/types";

export function useRecoveryIntelligence(userId: string) {
  return useQuery<RecoveryIntelligencePayload>({
    queryKey: queryKeys.recoveryIntelligence.one(userId),
    queryFn: fetchRecoveryIntelligenceBrowser,
    enabled: !!userId,
    // SSR-hydrate-only: the browser fetcher throws by design. staleTime
    // Infinity tells TanStack Query to trust the dehydrated cache for the
    // page lifetime; without it the cache is stale on mount and a
    // background refetch fires → throws → red error replaces the charts.
    // Matches useCoachTrends.
    staleTime: Infinity,
  });
}
