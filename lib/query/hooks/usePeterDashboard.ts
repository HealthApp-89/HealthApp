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
    // Must be paired with gcTime: Infinity (below) so the cache survives
    // the 5min default GC window. Matches useRecoveryIntelligence.
    staleTime: Infinity,
    // Pair with staleTime to prevent client-side GC eviction. Without this,
    // navigating away and back after 5 minutes evicts the cache → refetch
    // fires fetchPeterDashboardBrowser → throws → "Failed to load" replaces
    // the dashboard. The browser fetcher is intentionally throw-only; we
    // rely on the SSR hydrate + zero refetches for the page lifetime.
    gcTime: Infinity,
  });
}
