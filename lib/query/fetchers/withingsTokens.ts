// lib/query/fetchers/withingsTokens.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export type WithingsTokensRow = {
  updated_at: string;
  withings_user_id: string | null;
} | null;

export async function fetchWithingsTokensServer(
  supabase: SupabaseClient,
  userId: string,
): Promise<WithingsTokensRow> {
  const { data, error } = await supabase
    .from("withings_tokens")
    .select("updated_at, withings_user_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return (data as WithingsTokensRow) ?? null;
}

export async function fetchWithingsTokensBrowser(
  userId: string,
): Promise<WithingsTokensRow> {
  const supabase = createSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("withings_tokens")
    .select("updated_at, withings_user_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return (data as WithingsTokensRow) ?? null;
}
