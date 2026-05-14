// lib/query/fetchers/intakeState.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { IntakeState as CheckinIntakeState } from "@/lib/data/types";

/**
 * Reads `checkins.intake_state` for a (user, day). Returns the typed
 * IntakeState union or `null` when no row exists yet (user hasn't started
 * today's intake).
 *
 * Used by Slice 4's BriefStateChip on the dashboard to decide which compact
 * pill to render above ReadinessHero. Note the column on `checkins` is
 * `date` (YYYY-MM-DD), so callers pass today's ISO date as `day`.
 *
 * Both variants throw on Supabase errors so TanStack Query lights up
 * `isError` rather than silently rendering a stale/wrong chip.
 */

export type IntakeState = CheckinIntakeState | null;

export async function fetchIntakeStateServer(
  supabase: SupabaseClient,
  userId: string,
  day: string,
): Promise<IntakeState> {
  const { data, error } = await supabase
    .from("checkins")
    .select("intake_state")
    .eq("user_id", userId)
    .eq("date", day)
    .maybeSingle<{ intake_state: CheckinIntakeState | null }>();
  if (error) throw error;
  return data?.intake_state ?? null;
}

export async function fetchIntakeStateBrowser(
  userId: string,
  day: string,
): Promise<IntakeState> {
  const supabase = createSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("checkins")
    .select("intake_state")
    .eq("user_id", userId)
    .eq("date", day)
    .maybeSingle<{ intake_state: CheckinIntakeState | null }>();
  if (error) throw error;
  return data?.intake_state ?? null;
}
