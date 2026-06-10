// lib/query/hooks/useUserToday.ts
"use client";
import { useProfile } from "@/lib/query/hooks/useProfile";
import { todayInUserTz } from "@/lib/time";

/** YYYY-MM-DD in profile.timezone, or `undefined` while the profile loads.
 *
 *  Callers MUST guard against `undefined` before using the result for writes
 *  or persistence. Pages following the hybrid-SSR-hydrate pattern (CLAUDE.md)
 *  prefetch the profile server-side, so in practice this hook returns a string
 *  on the first client render — but the type forces the discipline.
 */
export function useUserToday(userId: string): string | undefined {
  const { data: profile } = useProfile(userId);
  if (!profile) return undefined;
  return todayInUserTz(new Date(), profile.timezone);
}
