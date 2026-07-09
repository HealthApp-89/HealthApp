// lib/query/fetchers/symptomLog.ts
//
// Reads from symptom_log_entries (migration 0026). Surfaces the user's
// free-text symptom journal entries with kind tags (sickness | injury |
// soreness | other). RLS-scoped to the authenticated user.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createFetcher } from "@/lib/query/fetchers/create-fetcher";

export type SymptomKind = "sickness" | "injury" | "soreness" | "other";

export type SymptomLogEntry = {
  id: string;
  kind: SymptomKind;
  notes: string;
  created_at: string;
};

const COLS = "id, kind, notes, created_at";

const symptomLog = createFetcher(
  async (supabase: SupabaseClient, userId: string, limit: number): Promise<SymptomLogEntry[]> => {
    const { data, error } = await supabase
      .from("symptom_log_entries")
      .select(COLS)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data ?? []) as SymptomLogEntry[];
  },
);

export const fetchSymptomLogServer = symptomLog.server;
export const fetchSymptomLogBrowser = symptomLog.browser;
