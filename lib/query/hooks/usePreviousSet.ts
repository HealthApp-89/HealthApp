// lib/query/hooks/usePreviousSet.ts
"use client";

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchPreviousSetBrowser } from "@/lib/query/fetchers/previousSet";

/**
 * Per-(exercise_name, set_index) lookup for the SetRow's "Previous" column.
 * 60s staleTime keeps scrolling cheap; result rarely changes during a session.
 */
export function usePreviousSet(args: {
  userId: string;
  exerciseName: string;
  setIndex: number;
  excludeWorkoutExternalId: string | null;
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: queryKeys.previousSet.one(args.userId, args.exerciseName, args.setIndex, args.excludeWorkoutExternalId),
    queryFn: () =>
      fetchPreviousSetBrowser({
        userId: args.userId,
        exerciseName: args.exerciseName,
        setIndex: args.setIndex,
        excludeWorkoutExternalId: args.excludeWorkoutExternalId,
      }),
    enabled: (args.enabled ?? true) && !!args.userId && !!args.exerciseName,
    staleTime: 60_000,
  });
}
