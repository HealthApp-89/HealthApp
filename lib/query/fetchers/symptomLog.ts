// lib/query/fetchers/symptomLog.ts
//
// Reads from symptom_log_entries (migration 0026). Surfaces the user's
// free-text symptom journal entries with kind tags (sickness | injury |
// soreness | other). RLS-scoped to the authenticated user.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export type SymptomKind = "sickness" | "injury" | "soreness" | "other";

export type SymptomLogEntry = {
  id: string;
  kind: SymptomKind;
  notes: string;
  created_at: string;
};

const COLS = "id, kind, notes, created_at";

export async function fetchSymptomLogServer(
  supabase: SupabaseClient,
  userId: string,
  limit = 30,
): Promise<SymptomLogEntry[]> {
  const { data, error } = await supabase
    .from("symptom_log_entries")
    .select(COLS)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as SymptomLogEntry[];
}

export async function fetchSymptomLogBrowser(
  userId: string,
  limit = 30,
): Promise<SymptomLogEntry[]> {
  const supabase = createSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("symptom_log_entries")
    .select(COLS)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as SymptomLogEntry[];
}
