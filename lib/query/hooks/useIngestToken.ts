// lib/query/hooks/useIngestToken.ts
"use client";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchIngestTokenBrowser } from "@/lib/query/fetchers/ingestToken";

export function useIngestToken(userId: string) {
  return useQuery({
    queryKey: queryKeys.tokens.ingest(userId),
    queryFn: () => fetchIngestTokenBrowser(userId),
    staleTime: 5 * 60_000,
    refetchOnMount: false,
  });
}
