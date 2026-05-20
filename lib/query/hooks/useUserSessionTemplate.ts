// lib/query/hooks/useUserSessionTemplate.ts
"use client";

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/keys";
import { fetchUserSessionTemplateBrowser } from "@/lib/query/fetchers/userSessionTemplates";

export function useUserSessionTemplate(userId: string, sessionType: string) {
  return useQuery({
    queryKey: queryKeys.userSessionTemplates.one(userId, sessionType),
    queryFn: () => fetchUserSessionTemplateBrowser(userId, sessionType),
    enabled: !!userId && !!sessionType,
  });
}
