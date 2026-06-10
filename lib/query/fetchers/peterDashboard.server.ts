// lib/query/fetchers/peterDashboard.server.ts
//
// Server-only fetcher for the Peter Dashboard row. Split out of
// peterDashboard.ts so the browser fetcher (transitively imported by the
// usePeterDashboard client hook) does NOT pull lib/coach/peter-dashboard
// — which imports getTodayTargets → lib/supabase/server → next/headers —
// into the browser bundle.

import type { SupabaseClient } from '@supabase/supabase-js';
import { loadLatestPeterDashboard } from '@/lib/coach/peter-dashboard';
import type { PeterDashboardRow } from '@/lib/query/fetchers/peterDashboard';

export async function fetchPeterDashboardServer(
  supabase: SupabaseClient,
  userId: string,
  today: string,
): Promise<PeterDashboardRow> {
  return loadLatestPeterDashboard(supabase, userId, today);
}
