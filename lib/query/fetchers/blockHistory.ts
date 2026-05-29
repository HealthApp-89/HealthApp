// lib/query/fetchers/blockHistory.ts
//
// SSR-hydrate-only fetcher pair for the trends-page Block History card.
// Mirrors lib/query/fetchers/coachTrends.ts — server runs the composer,
// browser throws by design (the page is SSR-rendered).

import type { SupabaseClient } from "@supabase/supabase-js";
import { composeBlockHistoryForTrends } from "@/lib/coach/trends/compose-block-history";
import type { BlockTrajectoryPayload } from "@/lib/data/types";

export async function fetchBlockHistoryServer(
  supabase: SupabaseClient,
  userId: string,
  todayIso: string,
): Promise<BlockTrajectoryPayload> {
  return composeBlockHistoryForTrends({ supabase, userId, todayIso });
}

export async function fetchBlockHistoryBrowser(
  userId: string,
  todayIso: string,
): Promise<BlockTrajectoryPayload> {
  void userId;
  void todayIso;
  throw new Error("blockHistory browser fetcher: not implemented — use SSR hydrate only.");
}
