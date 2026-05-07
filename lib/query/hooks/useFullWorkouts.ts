// lib/query/hooks/useFullWorkouts.ts
"use client";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchAllWorkoutsBrowser } from "@/lib/query/fetchers/loadWorkouts";

/** Full workout history for /strength — PRs, trends, recent-sessions list. */
export function useFullWorkouts(userId: string) {
  return useQuery({
    queryKey: queryKeys.workouts.all(userId),
    queryFn: () => fetchAllWorkoutsBrowser(userId),
    staleTime: 5 * 60_000,
    refetchOnMount: false,
  });
}
