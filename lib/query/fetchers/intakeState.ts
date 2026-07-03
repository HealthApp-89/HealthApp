// lib/query/fetchers/intakeState.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { IntakeState as CheckinIntakeState } from "@/lib/data/types";
import { createFetcher } from "@/lib/query/fetchers/create-fetcher";

/**
 * Reads `checkins.intake_state` for a (user, day). Returns the typed
 * IntakeState union or `null` when no row exists yet (user hasn't started
 * today's intake).
 *
 * Consumed by morning-intake/brief code paths to decide what UI to render
 * for today (continue check-in, retry brief, etc.). Note the column on
 * `checkins` is `date` (YYYY-MM-DD), so callers pass today's ISO date as `day`.
 *
 * Both variants throw on Supabase errors so TanStack Query lights up
 * `isError` rather than silently rendering a stale/wrong chip.
 */

export type IntakeState = CheckinIntakeState | null;

const intakeState = createFetcher(
  async (supabase: SupabaseClient, userId: string, day: string): Promise<IntakeState> => {
    const { data, error } = await supabase
      .from("checkins")
      .select("intake_state")
      .eq("user_id", userId)
      .eq("date", day)
      .maybeSingle<{ intake_state: CheckinIntakeState | null }>();
    if (error) throw error;
    return data?.intake_state ?? null;
  },
);

export const fetchIntakeStateServer = intakeState.server;
export const fetchIntakeStateBrowser = intakeState.browser;
