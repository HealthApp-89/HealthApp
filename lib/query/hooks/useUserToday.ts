// lib/query/hooks/useUserToday.ts
"use client";
import { todayInUserTz } from "@/lib/time";

/** YYYY-MM-DD in the user's calendar timezone.
 *
 *  v1 transitional: reads the env-var default inside `todayInUserTz`. The real
 *  profile-aware wiring lands in Task 3 when `todayInUserTz(now, tz)` accepts
 *  an explicit `tz` argument. The signature stays stable across that change so
 *  callsites adopted in Task 7 do not need to be touched a second time.
 */
export function useUserToday(_userId: string): string {
  return todayInUserTz();
}
