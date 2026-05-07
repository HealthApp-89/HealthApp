// lib/query/fetchers/ingestToken.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export type IngestTokenRow = {
  token_prefix: string | null;
  created_at: string | null;
  last_used_at: string | null;
  last_used_source: string | null;
} | null;

const COLS = "token_prefix, created_at, last_used_at, last_used_source";

export async function fetchIngestTokenServer(
  supabase: SupabaseClient,
  userId: string,
): Promise<IngestTokenRow> {
  const { data, error } = await supabase
    .from("ingest_tokens")
    .select(COLS)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return (data as IngestTokenRow) ?? null;
}

export async function fetchIngestTokenBrowser(userId: string): Promise<IngestTokenRow> {
  const supabase = createSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("ingest_tokens")
    .select(COLS)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return (data as IngestTokenRow) ?? null;
}
