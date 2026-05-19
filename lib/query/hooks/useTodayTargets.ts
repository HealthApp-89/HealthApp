// lib/query/hooks/useTodayTargets.ts
"use client";

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchTodayTargetsBrowser } from "@/lib/query/fetchers/todayTargets";

export function useTodayTargets(userId: string, date: string) {
  return useQuery({
    queryKey: queryKeys.todayTargets.byDate(userId, date),
    queryFn: fetchTodayTargetsBrowser,
    enabled: !!userId,
  });
}
