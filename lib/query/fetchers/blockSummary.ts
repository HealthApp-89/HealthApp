// lib/query/fetchers/blockSummary.ts
//
// Server assembles; browser re-assembles via the RLS client — both call the
// same compute module, so the payload can never drift between SSR hydrate
// and client refetch. assembleBlockSummary throws on Supabase errors, so
// TanStack Query lights up isError (standard fetcher contract).

import type { SupabaseClient } from "@supabase/supabase-js";
import { assembleBlockSummary, type BlockSummaryPayload } from "@/lib/coach/blocks/summary";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export async function fetchBlockSummaryServer(
  supabase: SupabaseClient, userId: string, todayIso: string,
): Promise<BlockSummaryPayload | null> {
  return assembleBlockSummary({ supabase, userId, todayIso });
}

export async function fetchBlockSummaryBrowser(
  userId: string, todayIso: string,
): Promise<BlockSummaryPayload | null> {
  const supabase = createSupabaseBrowserClient();
  return assembleBlockSummary({ supabase: supabase as unknown as SupabaseClient, userId, todayIso });
}
