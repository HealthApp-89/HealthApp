// lib/query/hooks/useUserSessionTemplates.ts
"use client";

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchAllUserSessionTemplatesBrowser } from "@/lib/query/fetchers/userSessionTemplates";

/**
 * All user_session_templates rows for the user, keyed by session_type.
 * Used by the Schedule sub-tab.
 */
export function useUserSessionTemplates(userId: string) {
  return useQuery({
    queryKey: queryKeys.userSessionTemplates.all(userId),
    queryFn: () => fetchAllUserSessionTemplatesBrowser(userId),
    staleTime: 5 * 60_000,
    refetchOnMount: false,
    enabled: !!userId,
  });
}
