// lib/query/hooks/useTrainingWeek.ts
"use client";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchTrainingWeekBrowser } from "@/lib/query/fetchers/trainingWeek";

/** Single committed training_week row (or null). Used by the strength tab to
 *  resolve TodayPlanCard.session_plan and by /coach to render WeekPlanCard. */
export function useTrainingWeek(userId: string, weekStart: string) {
  return useQuery({
    queryKey: queryKeys.trainingWeeks.one(userId, weekStart),
    queryFn: () => fetchTrainingWeekBrowser(userId, weekStart),
    staleTime: 60_000,
    refetchOnMount: false,
  });
}
