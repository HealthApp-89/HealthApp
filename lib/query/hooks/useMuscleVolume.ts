// lib/query/hooks/useMuscleVolume.ts

"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchMuscleVolumeBrowser } from "@/lib/query/fetchers/muscleVolume";
import { queryKeys } from "@/lib/query/keys";

/** Reads the per-muscle volume snapshot for the given user + day.
 *  `today` should be the user's tz-resolved ISO date (the strength
 *  page's server prefetch passes this through hydration). */
export function useMuscleVolume(userId: string, today: string) {
  return useQuery({
    queryKey: queryKeys.muscleVolume.snapshot(userId, today),
    queryFn: () => fetchMuscleVolumeBrowser(userId, today),
    staleTime: 5 * 60_000, // 5 minutes
  });
}
