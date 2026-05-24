import type { SupabaseClient } from '@supabase/supabase-js';
import { loadLatestPeterDashboard } from '@/lib/coach/peter-dashboard';
import type { PeterDashboardPayload } from '@/lib/data/types';

export type PeterDashboardRow = {
  payload: PeterDashboardPayload;
  narrative_md: string;
  generated_on: string;
  version: number;
} | null;

export async function fetchPeterDashboardServer(
  supabase: SupabaseClient,
  userId: string,
  today: string,
): Promise<PeterDashboardRow> {
  return loadLatestPeterDashboard(supabase, userId, today);
}

export async function fetchPeterDashboardBrowser(): Promise<PeterDashboardRow> {
  throw new Error(
    'peterDashboard browser fetcher: not implemented — use SSR hydrate only.',
  );
}
