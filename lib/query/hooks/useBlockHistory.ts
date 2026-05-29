"use client";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import type { BlockTrajectoryPayload } from "@/lib/data/types";

export function useBlockHistory(userId: string) {
  return useQuery<BlockTrajectoryPayload>({
    queryKey: queryKeys.blockHistory.one(userId),
    queryFn: async (): Promise<BlockTrajectoryPayload> => {
      throw new Error("useBlockHistory: expected SSR-hydrated cache hit");
    },
    // Mirrors useCoachTrends — SSR-hydrate-only, no browser refetch path.
    staleTime: Infinity,
  });
}
