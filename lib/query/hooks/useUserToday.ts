// lib/query/hooks/useUserToday.ts
"use client";
import { useProfile } from "@/lib/query/hooks/useProfile";
import { todayInUserTz } from "@/lib/time";

export function useUserToday(userId: string): string {
  // tz wiring lands in Task 3 (lib/time.ts gets a tz parameter).
  // Until then, falls back to the env-var default inside todayInUserTz.
  void useProfile(userId); // hold the slot so the import isn't dead.
  return todayInUserTz();
}
