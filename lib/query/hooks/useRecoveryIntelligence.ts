"use client";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchRecoveryIntelligenceBrowser } from "@/lib/query/fetchers/recoveryIntelligence";

export function useRecoveryIntelligence(userId: string) {
  return useQuery({
    queryKey: queryKeys.recoveryIntelligence.one(userId),
    queryFn: fetchRecoveryIntelligenceBrowser,
    enabled: !!userId,
  });
}
