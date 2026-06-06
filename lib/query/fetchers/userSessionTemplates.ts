// lib/query/fetchers/userSessionTemplates.ts
//
// Per-user persistent override for a given session_type (the "save deviations
// as my default" layer from migration 0026). Returns null when no override
// has been saved — that's the steady state, not an error.
//
// Server + browser variants follow the hybrid SSR-hydrate pattern documented
// in CLAUDE.md. The LoggerSheet (Task 11) hydrates with this to detect
// divergence between SESSION_PLANS and the user's saved default.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { UserSessionTemplate } from "@/lib/data/types";

const SELECT = "user_id, session_type, exercises, updated_at";

/**
 * Server variant takes the supabase client as an argument so this file
 * doesn't pull `next/headers` into client bundles. Matches the canonical
 * pattern from `dailyLogs.ts`.
 */
export async function fetchUserSessionTemplateServer(
  supabase: SupabaseClient,
  userId: string,
  sessionType: string,
): Promise<UserSessionTemplate | null> {
  const { data, error } = await supabase
    .from("user_session_templates")
    .select(SELECT)
    .eq("user_id", userId)
    .eq("session_type", sessionType)
    .maybeSingle();
  if (error) throw error;
  return (data as UserSessionTemplate | null) ?? null;
}

export async function fetchUserSessionTemplateBrowser(
  userId: string,
  sessionType: string,
): Promise<UserSessionTemplate | null> {
  const supabase = createSupabaseBrowserClient();
  return fetchUserSessionTemplateServer(supabase, userId, sessionType);
}

/**
 * Plural variant — fetches every user_session_templates row for the user
 * and returns a map keyed by session_type. Used by the Schedule sub-tab
 * which renders up to five distinct session types per week and would
 * otherwise fan out one query per (weekday, session_type) pair.
 */
export async function fetchAllUserSessionTemplatesServer(
  supabase: SupabaseClient,
  userId: string,
): Promise<Record<string, UserSessionTemplate>> {
  const { data, error } = await supabase
    .from("user_session_templates")
    .select(SELECT)
    .eq("user_id", userId);
  if (error) throw error;
  const rows = (data ?? []) as UserSessionTemplate[];
  const map: Record<string, UserSessionTemplate> = {};
  for (const row of rows) map[row.session_type] = row;
  return map;
}

export async function fetchAllUserSessionTemplatesBrowser(
  userId: string,
): Promise<Record<string, UserSessionTemplate>> {
  const supabase = createSupabaseBrowserClient();
  return fetchAllUserSessionTemplatesServer(supabase, userId);
}
