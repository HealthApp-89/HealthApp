// lib/query/hooks/useLast7.ts
"use client";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchLast7Browser } from "@/lib/query/fetchers/last7";

export function useLast7(userId: string, beforeDate: string, sevenDaysBefore: string) {
  return useQuery({
    queryKey: queryKeys.dailyLogs.last7(userId, beforeDate),
    queryFn: () => fetchLast7Browser(userId, beforeDate, sevenDaysBefore),
    staleTime: 60_000,
    refetchOnMount: false,
  });
}
