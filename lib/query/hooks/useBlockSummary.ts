"use client";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchBlockSummaryBrowser } from "@/lib/query/fetchers/blockSummary";

/** Block Command Center summary payload (null = no active block). `todayIso`
 *  comes from useUserToday — may be undefined while the profile loads, hence
 *  the `enabled` guard. */
export function useBlockSummary(userId: string, todayIso: string) {
  return useQuery({
    queryKey: queryKeys.blockSummary.today(userId, todayIso),
    queryFn: () => fetchBlockSummaryBrowser(userId, todayIso),
    enabled: !!todayIso,
  });
}
