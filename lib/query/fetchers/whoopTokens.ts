// lib/query/fetchers/whoopTokens.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export type WhoopTokensRow = { updated_at: string; whoop_user_id: string | null } | null;

export async function fetchWhoopTokensServer(
  supabase: SupabaseClient,
  userId: string,
): Promise<WhoopTokensRow> {
  const { data, error } = await supabase
    .from("whoop_tokens")
    .select("updated_at, whoop_user_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return (data as WhoopTokensRow) ?? null;
}

export async function fetchWhoopTokensBrowser(userId: string): Promise<WhoopTokensRow> {
  const supabase = createSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("whoop_tokens")
    .select("updated_at, whoop_user_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return (data as WhoopTokensRow) ?? null;
}
