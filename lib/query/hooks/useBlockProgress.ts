// lib/query/hooks/useBlockProgress.ts
"use client";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchBlockProgressBrowser } from "@/lib/query/fetchers/blockProgress";

export function useBlockProgress(userId: string) {
  return useQuery({
    queryKey: queryKeys.blockProgress.active(userId),
    queryFn: fetchBlockProgressBrowser,
    staleTime: 60_000,
    refetchOnMount: false,
  });
}
