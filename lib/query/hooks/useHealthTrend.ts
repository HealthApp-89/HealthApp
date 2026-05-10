// lib/query/hooks/useHealthTrend.ts
"use client";

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchHealthTrendBrowser } from "@/lib/query/fetchers/healthTrend";

export function useHealthTrend(userId: string, from: string, to: string) {
  return useQuery({
    queryKey: queryKeys.healthTrend.range(userId, from, to),
    queryFn: () => fetchHealthTrendBrowser(userId, from, to),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    refetchOnMount: false,
  });
}
