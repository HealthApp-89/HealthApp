// lib/query/hooks/useAthleteProfile.ts
"use client";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchActiveProfileBrowser } from "@/lib/query/fetchers/athleteProfile";

/** Active acknowledged athlete profile, or null if none exists. */
export function useAthleteProfile(userId: string) {
  return useQuery({
    queryKey: queryKeys.athleteProfile.active(userId),
    queryFn: () => fetchActiveProfileBrowser(userId),
  });
}
