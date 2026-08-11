// lib/query/hooks/useTodaySessionStatus.ts
"use client";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import {
  fetchTodaySessionBrowser,
  type TodaySessionWorkout,
} from "@/lib/query/fetchers/todaySession";
import { useExistingLoggerDraft } from "@/lib/logger/use-existing-draft";

/** Single source of truth for "is today's session done?", consumed by both
 *  TodayPlanCard (/strength) and BriefSessionList (home tab) so the two
 *  surfaces cannot disagree.
 *
 *  `logged` and `hasDraft` are independent, not exclusive: committing then
 *  starting a fresh draft leaves both true, and the card shows both
 *  affordances rather than guessing which the athlete meant. */
export function useTodaySessionStatus(
  userId: string,
  date: string,
  sessionType: string,
  epoch: number = 0,
): { logged: TodaySessionWorkout | null; hasDraft: boolean; isLoading: boolean } {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.todaySession.one(userId, date),
    queryFn: () => fetchTodaySessionBrowser(userId, date),
    enabled: !!userId && !!date,
    staleTime: 30_000,
  });
  const hasDraft = useExistingLoggerDraft(userId, sessionType, epoch);
  return { logged: data ?? null, hasDraft, isLoading };
}
