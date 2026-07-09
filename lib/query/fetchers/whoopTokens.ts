// lib/query/fetchers/whoopTokens.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFetcher } from "@/lib/query/fetchers/create-fetcher";

export type WhoopTokensRow = { updated_at: string; whoop_user_id: string | null } | null;

const whoopTokens = createFetcher(
  async (supabase: SupabaseClient, userId: string): Promise<WhoopTokensRow> => {
    const { data, error } = await supabase
      .from("whoop_tokens")
      .select("updated_at, whoop_user_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw error;
    return (data as WhoopTokensRow) ?? null;
  },
);

export const fetchWhoopTokensServer = whoopTokens.server;
export const fetchWhoopTokensBrowser = whoopTokens.browser;
