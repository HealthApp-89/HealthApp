// lib/query/hooks/useAthleteProfileDraft.ts
"use client";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchDraftProfileBrowser } from "@/lib/query/fetchers/athleteProfile";

/** Current open draft, or null if none. At most one per user. */
export function useAthleteProfileDraft(userId: string) {
  return useQuery({
    queryKey: queryKeys.athleteProfile.draft(userId),
    queryFn: () => fetchDraftProfileBrowser(userId),
  });
}
