'use client';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query/keys';
import {
  fetchPeterDashboardBrowser,
  type PeterDashboardRow,
} from '@/lib/query/fetchers/peterDashboard';

export function usePeterDashboard(userId: string, today: string) {
  return useQuery<PeterDashboardRow>({
    queryKey: queryKeys.peterDashboard.latest(userId, today),
    queryFn: fetchPeterDashboardBrowser,
    enabled: !!userId && !!today,
    // SSR-hydrate-only: the browser fetcher throws by design. staleTime
    // Infinity tells TanStack Query to trust the dehydrated cache for the
    // page lifetime; without it the cache is stale on mount and a
    // background refetch fires → throws → red error replaces the dashboard.
    // Matches useRecoveryIntelligence.
    staleTime: Infinity,
  });
}
