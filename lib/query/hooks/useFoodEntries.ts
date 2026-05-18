// lib/query/hooks/useFoodEntries.ts
"use client";

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchFoodEntriesBrowser } from "@/lib/query/fetchers/foodEntries";

export function useFoodEntries(userId: string, from: string, to: string) {
  return useQuery({
    queryKey: queryKeys.foodEntries.range(userId, from, to),
    queryFn: () => fetchFoodEntriesBrowser(userId, from, to),
    enabled: !!userId,
  });
}
