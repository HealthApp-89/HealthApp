// lib/query/hooks/useEnduranceActivities.ts
"use client";

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchEnduranceActivitiesBrowser } from "@/lib/query/fetchers/enduranceActivities";

export function useEnduranceActivities(
  userId: string,
  from: string,
  to: string,
  opts: { enabled?: boolean; refetchInterval?: number | false } = {},
) {
  return useQuery({
    queryKey: queryKeys.endurance.activities(userId, from, to),
    queryFn: () => fetchEnduranceActivitiesBrowser(userId, from, to),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    refetchOnMount: false,
    enabled: opts.enabled ?? true,
    refetchInterval: opts.refetchInterval ?? false,
  });
}
