// lib/query/hooks/useFoodEntries.ts
"use client";

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchFoodEntriesBrowser } from "@/lib/query/fetchers/foodEntries";
import { useProfile } from "@/lib/query/hooks/useProfile";

/** Committed food_log_entries for the inclusive calendar range [from, to].
 *
 *  Both bounds are days in the athlete's own timezone — the fetcher converts
 *  them into the UTC instant range that covers them. The query stays disabled
 *  until the profile (and so the timezone) has loaded, because running it
 *  against a guessed zone would cache entries under the wrong day. Pages
 *  following the hybrid-SSR-hydrate pattern prefetch the profile, so this
 *  resolves on the first client render. */
export function useFoodEntries(userId: string, from: string, to: string) {
  const { data: profile } = useProfile(userId);
  const tz = profile?.timezone;
  return useQuery({
    queryKey: queryKeys.foodEntries.range(userId, from, to),
    queryFn: () => fetchFoodEntriesBrowser(userId, from, to, tz as string),
    enabled: !!userId && !!tz,
  });
}
