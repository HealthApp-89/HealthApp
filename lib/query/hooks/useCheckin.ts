// lib/query/hooks/useCheckin.ts
"use client";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchCheckinBrowser } from "@/lib/query/fetchers/checkin";

export function useCheckin(
  userId: string,
  date: string,
  opts: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: queryKeys.checkin.one(userId, date),
    queryFn: () => fetchCheckinBrowser(userId, date),
    staleTime: 30_000,
    refetchOnMount: false,
    enabled: (opts.enabled ?? true) && !!userId,
  });
}
