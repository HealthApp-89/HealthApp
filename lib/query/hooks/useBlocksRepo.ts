// lib/query/hooks/useBlocksRepo.ts
"use client";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchBlocksRepoBrowser } from "@/lib/query/fetchers/blocksRepo";

export function useBlocksRepo(userId: string) {
  return useQuery({
    queryKey: queryKeys.blocksRepo.all(userId),
    queryFn: () => fetchBlocksRepoBrowser(userId),
    staleTime: 30_000,
  });
}
