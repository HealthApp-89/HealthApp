// lib/query/hooks/useCheckins.ts
"use client";

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchCheckinsRangeBrowser } from "@/lib/query/fetchers/checkinsRange";

export function useCheckins(
  userId: string,
  from: string,
  to: string,
  opts: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: queryKeys.checkin.range(userId, from, to),
    queryFn: () => fetchCheckinsRangeBrowser(userId, from, to),
    staleTime: 60_000,
    refetchOnMount: false,
    enabled: (opts.enabled ?? true) && !!userId,
  });
}
