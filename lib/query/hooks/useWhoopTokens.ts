// lib/query/hooks/useWhoopTokens.ts
"use client";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchWhoopTokensBrowser } from "@/lib/query/fetchers/whoopTokens";

export function useWhoopTokens(userId: string) {
  return useQuery({
    queryKey: queryKeys.tokens.whoop(userId),
    queryFn: () => fetchWhoopTokensBrowser(userId),
    staleTime: 5 * 60_000,
    refetchOnMount: false,
  });
}
