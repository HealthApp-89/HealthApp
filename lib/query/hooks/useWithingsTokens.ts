// lib/query/hooks/useWithingsTokens.ts
"use client";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchWithingsTokensBrowser } from "@/lib/query/fetchers/withingsTokens";

export function useWithingsTokens(userId: string) {
  return useQuery({
    queryKey: queryKeys.tokens.withings(userId),
    queryFn: () => fetchWithingsTokensBrowser(userId),
    staleTime: 5 * 60_000,
    refetchOnMount: false,
  });
}
