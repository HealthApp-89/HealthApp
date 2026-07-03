// lib/query/fetchers/withingsTokens.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFetcher } from "@/lib/query/fetchers/create-fetcher";

export type WithingsTokensRow = {
  updated_at: string;
  withings_user_id: string | null;
} | null;

const withingsTokens = createFetcher(
  async (supabase: SupabaseClient, userId: string): Promise<WithingsTokensRow> => {
    const { data, error } = await supabase
      .from("withings_tokens")
      .select("updated_at, withings_user_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw error;
    return (data as WithingsTokensRow) ?? null;
  },
);

export const fetchWithingsTokensServer = withingsTokens.server;
export const fetchWithingsTokensBrowser = withingsTokens.browser;
