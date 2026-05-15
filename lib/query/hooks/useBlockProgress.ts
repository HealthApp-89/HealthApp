// lib/query/hooks/useBlockProgress.ts
"use client";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import {
  fetchBlockProgressBrowser,
  type BlockProgressPayload,
} from "@/lib/query/fetchers/blockProgress";

export function useBlockProgress(userId: string) {
  return useQuery({
    queryKey: queryKeys.blockProgress.active(userId),
    queryFn: fetchBlockProgressBrowser,
    staleTime: 60_000,
    refetchOnMount: false,
  });
}

/** Whether the block-progress query result indicates an active block.
 *  The query result is a discriminated union: the active variant carries
 *  a `block` key with payload; the inactive variant has `active: false`.
 *  Centralised here so callers don't drift on which discriminant to test. */
export function isActiveBlock(
  data: BlockProgressPayload | undefined,
): boolean {
  return data != null && "block" in data;
}
