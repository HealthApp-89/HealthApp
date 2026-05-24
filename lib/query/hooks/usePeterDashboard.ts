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
    staleTime: Infinity,
  });
}
