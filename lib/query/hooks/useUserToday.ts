// lib/query/hooks/useUserToday.ts
"use client";
import { useProfile } from "@/lib/query/hooks/useProfile";
import { todayInUserTz } from "@/lib/time";

/** YYYY-MM-DD in profile.timezone. Returns a stable string per render. */
export function useUserToday(userId: string): string {
  const { data: profile } = useProfile(userId);
  const tz = profile?.timezone ?? "Asia/Dubai";
  return todayInUserTz(new Date(), tz);
}
