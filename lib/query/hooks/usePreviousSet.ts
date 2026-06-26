// lib/query/hooks/usePreviousSet.ts
"use client";

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchPreviousSetBrowser } from "@/lib/query/fetchers/previousSet";

/**
 * Per-(exercise_name, working-set ordinal) lookup for the SetRow's "Previous"
 * column. Ordinal is the 1-indexed position among non-warmup sets, so warmup
 * count drift across sessions can't misalign the comparison.
 * 60s staleTime keeps scrolling cheap; result rarely changes during a session.
 */
export function usePreviousSet(args: {
  userId: string;
  exerciseName: string;
  workingSetOrdinal: number;
  excludeWorkoutExternalId: string | null;
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: queryKeys.previousSet.one(args.userId, args.exerciseName, args.workingSetOrdinal, args.excludeWorkoutExternalId),
    queryFn: () =>
      fetchPreviousSetBrowser({
        userId: args.userId,
        exerciseName: args.exerciseName,
        workingSetOrdinal: args.workingSetOrdinal,
        excludeWorkoutExternalId: args.excludeWorkoutExternalId,
      }),
    enabled: (args.enabled ?? true) && !!args.userId && !!args.exerciseName && args.workingSetOrdinal >= 1,
    staleTime: 60_000,
  });
}
