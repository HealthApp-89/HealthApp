// lib/query/hooks/useProfile.ts
"use client";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchProfileBrowser } from "@/lib/query/fetchers/profile";

export function useProfile(userId: string) {
  return useQuery({
    queryKey: queryKeys.profile.one(userId),
    queryFn: () => fetchProfileBrowser(userId),
    staleTime: 5 * 60_000,
    refetchOnMount: false,
  });
}
