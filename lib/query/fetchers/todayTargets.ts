// lib/query/fetchers/todayTargets.ts
//
// Server + browser fetchers for TodayTargets. The browser variant routes
// through /api/profile/today-targets rather than calling getTodayTargets
// directly — too many cross-table reads for a client-side compute.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getTodayTargets, type TodayTargets } from "@/lib/morning/brief/get-today-targets";

export async function fetchTodayTargetsServer(
  supabase: SupabaseClient,
  userId: string,
): Promise<TodayTargets | null> {
  return getTodayTargets(supabase, userId);
}

export async function fetchTodayTargetsBrowser(): Promise<TodayTargets | null> {
  const res = await fetch("/api/profile/today-targets", { credentials: "include" });
  if (!res.ok) throw new Error(`today-targets fetch failed: ${res.status}`);
  const json = await res.json();
  return json.targets as TodayTargets | null;
}
