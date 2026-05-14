// lib/query/hooks/useIntakeState.ts
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchIntakeStateBrowser } from "@/lib/query/fetchers/intakeState";

/**
 * Today's `checkins.intake_state` for a user. 60s staleTime so navigating
 * back from /coach refreshes the dashboard chip after the user starts /
 * resumes / completes the morning intake flow.
 */
export function useIntakeState(userId: string, day: string) {
  return useQuery({
    queryKey: queryKeys.intakeState.one(userId, day),
    queryFn: () => fetchIntakeStateBrowser(userId, day),
    staleTime: 60_000,
  });
}
