// lib/query/fetchers/todayTargets.ts
//
// Browser fetcher for TodayTargets. The browser variant routes through
// /api/profile/today-targets rather than calling getTodayTargets directly —
// too many cross-table reads for a client-side compute.
//
// The server fetcher lives in todayTargets.server.ts. Don't merge the two
// back together — getTodayTargets transitively imports next/headers via
// lib/supabase/server, which would poison this module's browser bundle
// because useTodayTargets (a client hook) imports from here.

import type { TodayTargets } from "@/lib/morning/brief/get-today-targets";

export type { TodayTargets };

export async function fetchTodayTargetsBrowser(): Promise<TodayTargets | null> {
  const res = await fetch("/api/profile/today-targets", { credentials: "include" });
  if (!res.ok) throw new Error(`today-targets fetch failed: ${res.status}`);
  const json = await res.json();
  return json.targets as TodayTargets | null;
}
