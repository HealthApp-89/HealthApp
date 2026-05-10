// lib/query/hooks/useRecentE1RMs.ts
"use client";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchRecentE1RMsBrowser } from "@/lib/query/fetchers/recentE1RMs";

export function useRecentE1RMs(userId: string, today: string) {
  return useQuery({
    queryKey: queryKeys.recentE1RMs.one(userId, today),
    queryFn: () => fetchRecentE1RMsBrowser(userId, today),
    staleTime: 5 * 60_000, // 5 min — workouts don't change frequently
  });
}
