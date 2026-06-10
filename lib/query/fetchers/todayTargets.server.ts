// lib/query/fetchers/todayTargets.server.ts
//
// Server-only fetcher for TodayTargets. Split out of todayTargets.ts so that
// the browser fetcher (which is transitively imported by the useTodayTargets
// client hook) does NOT drag getTodayTargets — and its lib/supabase/server →
// next/headers dependency — into the browser bundle.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getTodayTargets,
  type TodayTargets,
} from "@/lib/morning/brief/get-today-targets";

export async function fetchTodayTargetsServer(
  supabase: SupabaseClient,
  userId: string,
): Promise<TodayTargets | null> {
  return getTodayTargets(supabase, userId);
}
