// lib/query/hooks/useWorkouts.ts
"use client";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchWorkoutsRangeBrowser } from "@/lib/query/fetchers/workouts";

export function useWorkouts(userId: string, fromDate: string, toDate: string, limit = 5) {
  return useQuery({
    queryKey: queryKeys.workouts.range(userId, fromDate, toDate),
    queryFn: () => fetchWorkoutsRangeBrowser(userId, fromDate, toDate, limit),
    staleTime: 60_000,
    refetchOnMount: false,
  });
}
