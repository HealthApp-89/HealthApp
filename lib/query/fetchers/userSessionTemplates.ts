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
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { UserSessionTemplate } from "@/lib/data/types";

const SELECT = "user_id, session_type, exercises, updated_at";

async function fetchOne(
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

export async function fetchUserSessionTemplateServer(
  userId: string,
  sessionType: string,
): Promise<UserSessionTemplate | null> {
  const supabase = await createSupabaseServerClient();
  return fetchOne(supabase, userId, sessionType);
}

export async function fetchUserSessionTemplateBrowser(
  userId: string,
  sessionType: string,
): Promise<UserSessionTemplate | null> {
  const supabase = createSupabaseBrowserClient();
  return fetchOne(supabase, userId, sessionType);
}
