// lib/query/fetchers/peterDashboard.ts
//
// Browser-side stub + shared PeterDashboardRow type. The server fetcher lives
// in peterDashboard.server.ts so this module can be transitively imported by
// usePeterDashboard (a client hook) without dragging next/headers into the
// browser bundle via lib/coach/peter-dashboard → get-today-targets →
// lib/supabase/server.

import type { PeterDashboardPayload } from '@/lib/data/types';

export type PeterDashboardRow = {
  payload: PeterDashboardPayload;
  narrative_md: string;
  generated_on: string;
  version: number;
} | null;

export async function fetchPeterDashboardBrowser(): Promise<PeterDashboardRow> {
  throw new Error(
    'peterDashboard browser fetcher: not implemented — use SSR hydrate only.',
  );
}
