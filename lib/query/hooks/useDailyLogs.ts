// lib/query/hooks/useDailyLogs.ts
"use client";

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchDailyLogsBrowser } from "@/lib/query/fetchers/dailyLogs";

export function useDailyLogs(
  userId: string,
  from: string,
  to: string,
  opts: { enabled?: boolean; refetchInterval?: number | false } = {},
) {
  return useQuery({
    queryKey: queryKeys.dailyLogs.range(userId, from, to),
    queryFn: () => fetchDailyLogsBrowser(userId, from, to),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    refetchOnMount: false,
    enabled: opts.enabled ?? true,
    refetchInterval: opts.refetchInterval ?? false,
  });
}
